#!/usr/bin/env node
// Claude Code hook: records the agent state of a task in the AI Tasks VS Code extension.
// Wired up only for terminals started by the AI Tasks extension (via `claude --settings <file>`),
// which pass AI_TASKS_STATUS_FILE in the environment. Anywhere else it is a no-op.
'use strict';
const fs = require('fs');
const path = require('path');

const file = process.env.AI_TASKS_STATUS_FILE;
if (!file) {
  process.exit(0);
}
const requested = process.argv[2];

let input = '';
let done = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', finish);
// Never hold the agent up if stdin is not closed for some reason.
setTimeout(finish, 1500).unref();

function finish() {
  if (done) return;
  done = true;
  let payload = {};
  try {
    payload = JSON.parse(input || '{}');
  } catch {
    // keep defaults
  }

  let state = requested;
  if (requested === 'notify') {
    // permission_prompt / elicitation_dialog: the agent is blocked on the user.
    // idle_prompt arrives a while after Stop and adds nothing; auth_success is noise.
    const type = payload.notification_type;
    if (type && type !== 'permission_prompt' && type !== 'elicitation_dialog') {
      process.exit(0);
    }
    state = 'waiting';
  }

  const record = {
    state,
    event: payload.hook_event_name,
    sessionId: payload.session_id,
    message: payload.message,
    ts: Date.now(),
  };
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
  } catch {
    // The status file is best effort; never fail the agent's turn because of it.
  }

  if (payload.hook_event_name === 'SessionStart') {
    tellAboutArtifacts();
  }

  // Paths the agent changed, so the IDE can show the changes of every repository the task works
  // in (sibling repos, nested repos, worktrees), not only those inside the opened folder.
  const touched = touchedPaths(payload);
  if (touched.length > 0) {
    try {
      fs.appendFileSync(file.replace(/\.json$/, '.writes'), JSON.stringify(touched) + '\n');
    } catch {
      // best effort
    }
  }
  process.exit(0);
}

/** Tools that write the file named in their input. */
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/**
 * Git subcommands that move a branch or change the working tree. Reads (status, log, diff, grep,
 * fetch) don't count: a task that only looked at a repo must not get its MR delta.
 */
const GIT_WRITES = new Set([
  'switch', 'checkout', 'commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'reset', 'restore',
  'stash', 'apply', 'am', 'pull', 'mv', 'rm',
]);

/** Only writes: files the agent edited and repos it ran a writing git command in. */
function touchedPaths(payload) {
  const paths = [];
  const input = payload.tool_input || {};
  if (WRITE_TOOLS.has(payload.tool_name)) {
    for (const key of ['file_path', 'notebook_path']) {
      if (typeof input[key] === 'string') paths.push(input[key]);
    }
  }
  if (typeof input.command === 'string') {
    paths.push(...gitWritePaths(input.command, typeof payload.cwd === 'string' ? payload.cwd : undefined));
  }
  return [...new Set(paths)];
}

/**
 * Repos a shell command changes through git. Follows `cd` between the parts of the command, so
 * `cd /d/repos/a && git commit` counts for `a`; `git worktree add` counts for the new worktree,
 * not for the repo it was created from.
 */
function gitWritePaths(command, cwd) {
  const paths = [];
  let dir = cwd;
  for (const part of command.split(/&&|\|\||[;\n|]/)) {
    const tokens = [...part.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    if (/^(cd|pushd|Set-Location|sl)$/i.test(tokens[0] ?? '')) {
      dir = resolveFrom(dir, tokens.slice(1).find((t) => !t.startsWith('-')));
      continue;
    }
    const git = tokens.findIndex((t) => /^git(\.exe)?$/i.test(t));
    if (git < 0) continue;
    let repo = dir;
    let i = git + 1;
    for (; i < tokens.length && tokens[i].startsWith('-'); i++) {
      if (tokens[i] === '-C') repo = resolveFrom(repo, tokens[++i]);
      else if (tokens[i] === '-c') i++;
    }
    if (tokens[i] === 'worktree' && tokens[i + 1] === 'add') {
      // The first non-option argument is the new worktree's folder.
      let j = i + 2;
      for (; j < tokens.length && tokens[j].startsWith('-'); j++) {
        if (['-b', '-B', '--reason'].includes(tokens[j])) j++;
      }
      const worktree = resolveFrom(repo, tokens[j]);
      if (worktree) paths.push(worktree);
    } else if (GIT_WRITES.has(tokens[i]) && repo) {
      paths.push(repo);
    }
  }
  return paths;
}

/** Absolute Windows path of `p` relative to `base`; undefined when unknown (no base, $VAR, ~). */
function resolveFrom(base, p) {
  if (!p || /[$~%`]/.test(p)) return undefined;
  const target = fromGitBash(p);
  if (path.isAbsolute(target) && /^[A-Za-z]:/.test(target)) return path.resolve(target);
  return base ? path.resolve(fromGitBash(base), target) : undefined;
}

/** `/d/x` (Git Bash) -> `d:/x`. */
function fromGitBash(p) {
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(p);
  return m ? `${m[1]}:${m[2] ?? '/'}` : p;
}

/** Asks the agent to keep the task's artifacts file (shown under the task in the Tasks view). */
function tellAboutArtifacts() {
  const artifacts = process.env.AI_TASKS_ARTIFACTS_FILE;
  if (!artifacts) return;
  const context =
    `This session is a task in the AI Tasks VS Code extension. Its artifacts file is ${artifacts.replace(/\\/g, '/')} ` +
    '(Markdown, sections: Jira, Merge requests, Confluence, Stand). Whenever you create, find or are given ' +
    "a link to this task's Jira issue, a merge request in any repository, a Confluence page you read or edited, " +
    'or the feature stand, add it to the matching section as `- [title](url)` with a short note ' +
    '(e.g. repo and MR state), without duplicates; update the note when the state changes. ' +
    'Keep only links there, nothing else.';
  try {
    // writeSync: the process exits right after, an async stdout write could be lost.
    fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
  } catch {
    // best effort
  }
}
