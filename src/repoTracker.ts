import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitAPI } from './changes';
import { log } from './log';
import { StatusWatcher } from './status';
import { TaskManager } from './tasks';

const STORAGE_KEY = 'aiTasks.touchedRepos';
const TASK_REPOS_KEY = 'aiTasks.taskRepoRoots';

/**
 * Makes the git extension (and so the Changes view) see every repository the agents work in,
 * and remembers which task each one belongs to.
 *
 * VS Code only discovers repositories inside the opened folder, a level or so deep. Agents
 * routinely edit sibling repos (`D:\repos\a` open, agent changes `D:\repos\b`) or repos nested
 * deeper. So: the repo of each task's folder, and of every path the agent wrote to (reported by
 * the Claude Code hook), is opened in the git extension and remembered for this workspace.
 * The Changes view shows only the active task's repositories: with a whole `D:\repos` folder
 * open, the git extension also finds every repo the other tasks are on.
 */
export class RepoTracker implements vscode.Disposable {
  /** lower-case root -> root */
  private readonly roots = new Map<string, string>();
  /** task id -> lower-case roots of its repositories */
  private readonly taskRoots = new Map<string, Set<string>>();
  /** lower-case folder -> repo root containing it (null: none) */
  private readonly rootCache = new Map<string, string | null>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<string>();
  /** Fires with the task id when a repository is added to a task. */
  readonly onDidChangeTaskRepos = this.emitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly git: GitAPI,
    status: StatusWatcher,
    private readonly tasks: TaskManager,
  ) {
    for (const root of context.workspaceState.get<string[]>(STORAGE_KEY, [])) {
      this.roots.set(root.toLowerCase(), root);
      void this.open(root);
    }
    const saved = context.workspaceState.get<Record<string, string[]>>(TASK_REPOS_KEY, {});
    for (const [taskId, roots] of Object.entries(saved)) {
      this.taskRoots.set(taskId, new Set(roots));
    }
    this.disposables.push(
      this.emitter,
      status.onTouched(({ taskId, paths }) => {
        if (this.tasks.get(taskId)) {
          for (const p of paths) {
            this.addPath(p, taskId);
          }
        }
      }),
      tasks.onDidChange(() => this.addTaskFolders()),
    );
    this.addTaskFolders();
    status.readAllTouched();
  }

  /** Lower-case roots of the task's repositories. */
  reposOf(taskId: string): ReadonlySet<string> {
    return this.taskRoots.get(taskId) ?? new Set();
  }

  /** Tracks the repository containing `p` (a file or folder), if any, for the given task. Returns its root. */
  addPath(p: string, taskId?: string): string | undefined {
    const normalized = normalizePath(p);
    if (!normalized) {
      return undefined;
    }
    const root = this.findRoot(normalized);
    if (!root || path.parse(root).root.toLowerCase() === root.toLowerCase()) {
      return undefined; // no repo, or a whole drive: never worth tracking
    }
    const key = root.toLowerCase();
    if (!this.roots.has(key)) {
      this.roots.set(key, root);
      this.save();
      log.info(`tracking repository ${root} (from ${p})`);
    }
    if (taskId) {
      let taskRoots = this.taskRoots.get(taskId);
      if (!taskRoots) {
        taskRoots = new Set();
        this.taskRoots.set(taskId, taskRoots);
      }
      if (!taskRoots.has(key)) {
        taskRoots.add(key);
        this.saveTaskRoots();
        this.emitter.fire(taskId);
      }
    }
    void this.open(root);
    return root;
  }

  private addTaskFolders(): void {
    for (const task of this.tasks.all) {
      this.addPath(task.data.cwd, task.id);
    }
    // Forget closed tasks.
    let pruned = false;
    for (const taskId of [...this.taskRoots.keys()]) {
      if (!this.tasks.get(taskId)) {
        this.taskRoots.delete(taskId);
        pruned = true;
      }
    }
    if (pruned) {
      this.saveTaskRoots();
    }
  }

  private saveTaskRoots(): void {
    const saved: Record<string, string[]> = {};
    for (const [taskId, roots] of this.taskRoots) {
      saved[taskId] = [...roots];
    }
    void this.context.workspaceState.update(TASK_REPOS_KEY, saved);
  }

  private findRoot(p: string): string | undefined {
    let dir = p;
    try {
      if (!fs.statSync(p).isDirectory()) {
        dir = path.dirname(p);
      }
    } catch {
      dir = path.dirname(p); // deleted file, or not a path at all: start from its folder
    }
    const visited: string[] = [];
    let result: string | null = null;
    for (;;) {
      const key = dir.toLowerCase();
      const cached = this.rootCache.get(key);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      visited.push(key);
      // A .git folder, or a .git file for worktrees and submodules.
      if (fs.existsSync(path.join(dir, '.git'))) {
        result = dir;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    for (const key of visited) {
      this.rootCache.set(key, result);
    }
    return result ?? undefined;
  }

  private async open(root: string): Promise<void> {
    if (this.git.repositories.some((r) => r.rootUri.fsPath.toLowerCase() === root.toLowerCase())) {
      return;
    }
    if (!fs.existsSync(path.join(root, '.git'))) {
      this.roots.delete(root.toLowerCase());
      this.save();
      return;
    }
    try {
      await this.git.openRepository(vscode.Uri.file(root));
    } catch (err) {
      log.warn(`cannot open repository ${root}: ${String(err)}`);
    }
  }

  private save(): void {
    void this.context.workspaceState.update(STORAGE_KEY, [...this.roots.values()]);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** Absolute Windows path from what the agent reported (also Git Bash `/d/x` form), or undefined. */
function normalizePath(raw: string): string | undefined {
  let p = raw.trim().replace(/[),.;:]+$/, '');
  const bash = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (bash) {
    p = `${bash[1]}:${bash[2] ?? '/'}`;
  }
  if (!path.isAbsolute(p) || !/^[a-zA-Z]:/.test(p)) {
    return undefined;
  }
  return path.resolve(p);
}
