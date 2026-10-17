import { execFile } from 'child_process';
import * as vscode from 'vscode';

/** What a merge request of the current branch would contain: everything since the merge base. */
export interface BranchDelta {
  /** The ref the branch is compared to, e.g. `origin/main`. */
  baseRef: string;
  /** Merge base commit of HEAD and `baseRef`; the left side of every diff. */
  mergeBase: string;
  files: DeltaFile[];
  additions: number;
  deletions: number;
}

export interface DeltaFile {
  /** `A` added, `M` modified, `D` deleted, `R` renamed, `T` type changed, `U` untracked. */
  status: string;
  /** Path relative to the repo root (the new path of a rename). */
  path: string;
  /** Path at the merge base, for renames. */
  oldPath?: string;
}

/**
 * Committed and uncommitted changes of the repo at `root` against the merge base with its base
 * branch, untracked files included: the MR as it would look if everything were pushed now.
 * Undefined when there is no base branch to compare with.
 */
export async function branchDelta(root: string): Promise<BranchDelta | undefined> {
  const baseRef = await findBaseRef(root);
  if (!baseRef) {
    return undefined;
  }
  const mergeBase = (await git(root, ['merge-base', 'HEAD', baseRef])).trim();
  if (!mergeBase) {
    return undefined;
  }
  const [nameStatus, numstat, untracked] = await Promise.all([
    git(root, ['diff', '--name-status', '-M', '-z', mergeBase]),
    git(root, ['diff', '--numstat', '-M', mergeBase]),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);

  const files: DeltaFile[] = [];
  const tokens = nameStatus.split('\0');
  for (let i = 0; i + 1 < tokens.length; ) {
    const status = tokens[i++].charAt(0);
    if (status === 'R' || status === 'C') {
      const oldPath = tokens[i++];
      files.push({ status: 'R', path: tokens[i++], oldPath });
    } else {
      files.push({ status, path: tokens[i++] });
    }
  }
  for (const p of untracked.split('\0').filter(Boolean)) {
    files.push({ status: 'U', path: p });
  }

  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n')) {
    const [added, deleted] = line.split('\t');
    // Binary files show "-".
    additions += Number(added) || 0;
    deletions += Number(deleted) || 0;
  }
  return { baseRef, mergeBase, files, additions, deletions };
}

/** Base ref per repo root (lower case). It changes only with the setting or the remote's default. */
const baseRefs = new Map<string, Promise<string | undefined>>();

export function clearBaseRefCache(): void {
  baseRefs.clear();
}

function findBaseRef(root: string): Promise<string | undefined> {
  const key = root.toLowerCase();
  let ref = baseRefs.get(key);
  if (!ref) {
    ref = resolveBaseRef(root);
    baseRefs.set(key, ref);
  }
  return ref;
}

/** `aiTasks.baseBranch`, else the remote's default branch, else a usual name that exists. */
async function resolveBaseRef(root: string): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('aiTasks').get<string>('baseBranch', '').trim();
  const candidates = configured ? [configured] : [];
  const remoteHead = (await git(root, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])).trim();
  if (remoteHead && remoteHead !== 'origin/HEAD') {
    candidates.push(remoteHead);
  }
  candidates.push('origin/main', 'origin/master', 'origin/develop', 'main', 'master');
  for (const ref of candidates) {
    if ((await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim()) {
      return ref;
    }
  }
  return undefined;
}

/** At most this many git processes at once, so a task with many repos does not flood the machine. */
const MAX_GIT_PROCESSES = 2;
let running = 0;
const waiting: Array<() => void> = [];

/**
 * Stdout of a git command, empty on failure. GIT_OPTIONAL_LOCKS=0 keeps `git diff` from
 * refreshing the index, which the git extension would report back as a change of the repo.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  if (running < MAX_GIT_PROCESSES) {
    running++;
  } else {
    // The finishing process hands its slot over, so `running` stays as it is.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  try {
    return await new Promise((resolve) => {
      execFile(
        'git',
        args,
        { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
        (err, stdout) => resolve(err ? '' : stdout),
      );
    });
  } finally {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      running--;
    }
  }
}
