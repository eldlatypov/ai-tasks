#!/usr/bin/env node
// Claude Code hook: records the agent state of an AI IDE task.
// Wired up only for terminals started by the AI IDE extension (via `claude --settings <file>`),
// which pass AI_IDE_STATUS_FILE in the environment. Anywhere else it is a no-op.
'use strict';
const fs = require('fs');

const file = process.env.AI_IDE_STATUS_FILE;
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

  // Paths the agent worked in, so the IDE can show changes of every repository it touched
  // (sibling repos, nested repos), not only those inside the opened folder.
  const touched = touchedPaths(payload);
  if (touched.length > 0) {
    try {
      fs.appendFileSync(file.replace(/\.json$/, '.touched'), JSON.stringify(touched) + '\n');
    } catch {
      // best effort
    }
  }
  process.exit(0);
}

function touchedPaths(payload) {
  const paths = [];
  if (typeof payload.cwd === 'string') paths.push(payload.cwd);
  const input = payload.tool_input || {};
  for (const key of ['file_path', 'notebook_path', 'path']) {
    if (typeof input[key] === 'string') paths.push(input[key]);
  }
  if (typeof input.command === 'string') {
    // Absolute paths in shell commands: D:\x, D:/x and Git Bash style /d/x.
    for (const m of input.command.matchAll(/(?:\b[A-Za-z]:[\\/]|(?<![\w.~-])\/[A-Za-z]\/)[^\s"'`|;&<>()]*/g)) {
      paths.push(m[0]);
    }
  }
  return [...new Set(paths)];
}

/** Asks the agent to keep the task's artifacts file (shown under the task in the Tasks view). */
function tellAboutArtifacts() {
  const artifacts = process.env.AI_IDE_ARTIFACTS_FILE;
  if (!artifacts) return;
  const context =
    `This session is an AI IDE task. Its artifacts file is ${artifacts.replace(/\\/g, '/')} ` +
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
