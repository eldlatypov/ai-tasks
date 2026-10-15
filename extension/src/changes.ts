import * as path from 'path';
import * as vscode from 'vscode';
import { BranchDelta, branchDelta, clearBaseRefCache } from './branchDelta';
import { fileColumn } from './tasks';

// --- the slice of the built-in git extension API (extensions/git/src/api/git.d.ts) we use ---

const enum Status {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,
  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
  INTENT_TO_RENAME,
  TYPE_CHANGED,
}

interface Change {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly renameUri: vscode.Uri | undefined;
  readonly status: Status;
}

interface RepositoryState {
  readonly HEAD: { readonly name?: string; readonly commit?: string } | undefined;
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  readonly untrackedChanges?: Change[];
  readonly mergeChanges?: Change[];
  readonly onDidChange: vscode.Event<void>;
}

interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: RepositoryState;
}

export interface GitAPI {
  readonly repositories: Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  openRepository(root: vscode.Uri): Promise<Repository | null>;
}

export async function getGitApi(): Promise<GitAPI | undefined> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPI }>('vscode.git');
  if (!extension) {
    return undefined;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports.getAPI(1);
}

// --- tree ----------------------------------------------------------------------------------

export interface ChangedFile {
  kind: 'file';
  repo: Repository;
  uri: vscode.Uri;
  status: Status;
  /** MR delta mode: the merge base the file is compared to, and its path there when renamed. */
  base?: string;
  originalUri?: vscode.Uri;
}

interface RepoNode {
  kind: 'repo';
  repo: Repository;
  files: ChangedFile[];
  delta?: BranchDelta;
}

/** `working`: uncommitted changes; `branch`: everything since the base branch (what the MR shows). */
export type ChangesMode = 'working' | 'branch';

const DELTA_STATUS: Record<string, Status> = {
  A: Status.INDEX_ADDED,
  D: Status.DELETED,
  R: Status.INDEX_RENAMED,
  T: Status.TYPE_CHANGED,
  U: Status.UNTRACKED,
};

interface FolderNode {
  kind: 'folder';
  repo: Repository;
  label: string;
  /** Relative path inside the repo. */
  path: string;
  children: Array<FolderNode | ChangedFile>;
}

type Node = RepoNode | FolderNode | ChangedFile;

const STATUS_LETTER: Record<number, string> = {
  [Status.INDEX_MODIFIED]: 'M',
  [Status.MODIFIED]: 'M',
  [Status.INDEX_ADDED]: 'A',
  [Status.INTENT_TO_ADD]: 'A',
  [Status.INDEX_DELETED]: 'D',
  [Status.DELETED]: 'D',
  [Status.INDEX_RENAMED]: 'R',
  [Status.INTENT_TO_RENAME]: 'R',
  [Status.INDEX_COPIED]: 'C',
  [Status.UNTRACKED]: 'U',
  [Status.TYPE_CHANGED]: 'T',
};

/**
 * "Only changes" explorer: changed files of every repository in the workspace, sibling repos
 * included. Either uncommitted changes, or the MR delta of each repo's branch.
 */
export class ChangesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly repoListeners = new Map<Repository, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];
  private renderTimer: NodeJS.Timeout | undefined;
  /** A render was skipped while the view was hidden. */
  private renderPending = false;
  private treeView: vscode.TreeView<Node> | undefined;
  private mode: ChangesMode = 'branch';
  private scope: (() => ReadonlySet<string> | undefined) | undefined;
  /**
   * MR deltas per repository. Each one costs several git processes (about a second of CPU on a
   * big repo), and this view shares the extension host with the task terminals, so a delta is
   * kept until its own repository changes rather than recomputed on every event.
   */
  private readonly deltas = new Map<Repository, Promise<BranchDelta | undefined>>();
  /** Last seen HEAD + working tree state per repository, to ignore events that change nothing. */
  private readonly fingerprints = new Map<Repository, string>();

  constructor(readonly git: GitAPI) {
    for (const repo of git.repositories) {
      this.track(repo);
    }
    this.disposables.push(
      git.onDidOpenRepository((repo) => {
        this.track(repo);
        this.render();
      }),
      git.onDidCloseRepository((repo) => {
        this.repoListeners.get(repo)?.dispose();
        this.repoListeners.delete(repo);
        this.deltas.delete(repo);
        this.fingerprints.delete(repo);
        this.render();
      }),
    );
  }

  attach(treeView: vscode.TreeView<Node>): void {
    this.treeView = treeView;
    this.disposables.push(
      treeView.onDidChangeVisibility(({ visible }) => {
        if (visible && this.renderPending) {
          this.render(0);
        }
      }),
    );
    this.setMode(this.mode);
  }

  get currentMode(): ChangesMode {
    return this.mode;
  }

  setMode(mode: ChangesMode): void {
    this.mode = mode;
    void vscode.commands.executeCommand('setContext', 'aiIde.changesMode', mode);
    if (this.treeView) {
      this.treeView.title = mode === 'branch' ? 'Changes · MR delta' : 'Changes';
    }
    this.render(0);
  }

  /** Recomputes everything: the refresh button, a changed base branch setting. */
  refresh(): void {
    this.deltas.clear();
    clearBaseRefCache();
    this.render(0);
  }

  /**
   * Redraws the view from the cached deltas, computing only the missing ones. Bursts of events
   * collapse into one redraw; nothing runs while the view is hidden.
   */
  render(delay = 1000): void {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      if (this.treeView && !this.treeView.visible) {
        this.renderPending = true;
        return;
      }
      this.renderPending = false;
      this.emitter.fire(undefined);
      void this.updateBadge();
    }, delay);
  }

  private track(repo: Repository): void {
    if (!this.repoListeners.has(repo)) {
      this.fingerprints.set(repo, fingerprint(repo));
      this.repoListeners.set(
        repo,
        repo.state.onDidChange(() => this.onRepoChange(repo)),
      );
    }
  }

  private onRepoChange(repo: Repository): void {
    // The git extension also fires after status runs that found nothing new.
    const current = fingerprint(repo);
    if (current === this.fingerprints.get(repo)) {
      return;
    }
    this.fingerprints.set(repo, current);
    this.deltas.delete(repo);
    // A repository outside the active task is recomputed when it comes into view, not now.
    if (this.inScope(repo)) {
      this.render();
    }
  }

  private inScope(repo: Repository): boolean {
    const roots = this.scope?.();
    return !roots || roots.has(repo.rootUri.fsPath.toLowerCase());
  }

  private changedFiles(repo: Repository): ChangedFile[] {
    const byPath = new Map<string, ChangedFile>();
    const { state } = repo;
    // Later lists win: the working tree state is what the user sees on disk.
    for (const change of [
      ...state.indexChanges,
      ...(state.mergeChanges ?? []),
      ...state.workingTreeChanges,
      ...(state.untrackedChanges ?? []),
    ]) {
      const uri = change.renameUri ?? change.uri;
      byPath.set(uri.fsPath.toLowerCase(), { kind: 'file', repo, uri, status: change.status });
    }
    return [...byPath.values()].sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
  }

  private delta(repo: Repository): Promise<BranchDelta | undefined> {
    let delta = this.deltas.get(repo);
    if (!delta) {
      delta = branchDelta(repo.rootUri.fsPath);
      this.deltas.set(repo, delta);
    }
    return delta;
  }

  private async deltaNode(repo: Repository): Promise<RepoNode> {
    const delta = await this.delta(repo);
    const files = (delta?.files ?? []).map(
      (f): ChangedFile => ({
        kind: 'file',
        repo,
        uri: vscode.Uri.joinPath(repo.rootUri, f.path),
        status: DELTA_STATUS[f.status] ?? Status.MODIFIED,
        base: delta?.mergeBase,
        originalUri: f.oldPath ? vscode.Uri.joinPath(repo.rootUri, f.oldPath) : undefined,
      }),
    );
    return { kind: 'repo', repo, files, delta };
  }

  /**
   * Limits the view to some repositories (lower-case roots), e.g. the active task's; a scope that
   * returns undefined shows every repository the git extension knows.
   */
  setScope(scope: () => ReadonlySet<string> | undefined): void {
    this.scope = scope;
    this.render(0);
  }

  private scopedRepositories(): Repository[] {
    return this.git.repositories.filter((repo) => this.inScope(repo));
  }

  private async repos(): Promise<RepoNode[]> {
    const repositories = this.scopedRepositories();
    const nodes =
      this.mode === 'branch'
        ? await Promise.all(repositories.map((repo) => this.deltaNode(repo)))
        : repositories.map((repo): RepoNode => ({ kind: 'repo', repo, files: this.changedFiles(repo) }));
    return nodes
      .filter((node) => node.files.length > 0)
      .sort((a, b) => path.basename(a.repo.rootUri.fsPath).localeCompare(path.basename(b.repo.rootUri.fsPath)));
  }

  private async updateBadge(): Promise<void> {
    if (!this.treeView) {
      return;
    }
    const total = (await this.repos()).reduce((sum, r) => sum + r.files.length, 0);
    const what = this.mode === 'branch' ? 'MR changes' : 'changes';
    const count = this.scopedRepositories().length;
    const whose = this.scope?.() ? " of this task's" : ' tracked';
    this.treeView.badge = total > 0 ? { value: total, tooltip: `${total} changed file(s)` } : undefined;
    this.treeView.message =
      total === 0 ? `No ${what} in ${count}${whose} repositor${count === 1 ? 'y' : 'ies'}.` : undefined;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.repos();
    }
    if (node.kind === 'repo') {
      return buildFolderTree(node.repo, node.files).children;
    }
    if (node.kind === 'folder') {
      return node.children;
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'repo') {
      // Collapsed: the repo line already shows the file count and +/− stats; folders inside open expanded.
      const item = new vscode.TreeItem(path.basename(node.repo.rootUri.fsPath), vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `repo:${node.repo.rootUri.fsPath}`;
      item.iconPath = new vscode.ThemeIcon('repo');
      const branch = node.repo.state.HEAD?.name;
      const count = `${node.files.length} ${node.delta ? 'file' : 'change'}${node.files.length === 1 ? '' : 's'}`;
      item.description = node.delta
        ? `${count} · +${node.delta.additions} −${node.delta.deletions} · ${branch ?? 'HEAD'} → ${node.delta.baseRef}`
        : `${count}${branch ? ` · ${branch}` : ''}`;
      item.tooltip = node.delta
        ? `${node.repo.rootUri.fsPath}\nCompared to the merge base with ${node.delta.baseRef} (${node.delta.mergeBase.slice(0, 8)}), uncommitted changes included`
        : node.repo.rootUri.fsPath;
      return item;
    }
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `folder:${node.repo.rootUri.fsPath}:${node.path}`;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.resourceUri = vscode.Uri.joinPath(node.repo.rootUri, node.path);
      return item;
    }
    // resourceUri gives the file icon plus git colouring from the built-in decorations.
    const item = new vscode.TreeItem(node.uri, vscode.TreeItemCollapsibleState.None);
    item.id = `file:${node.base ? 'mr:' : ''}${node.uri.fsPath}`;
    item.description = STATUS_LETTER[node.status] ?? '';
    item.tooltip = `${path.relative(node.repo.rootUri.fsPath, node.uri.fsPath)} — ${item.description}`;
    item.contextValue = 'change';
    item.command = { command: 'aiIde.openChange', title: 'Open Changes', arguments: [node] };
    return item;
  }

  /**
   * Diff against HEAD (the merge base in MR delta mode) for modified files; plain file for new
   * ones; the old version for deleted ones.
   */
  async openChange(file: ChangedFile): Promise<void> {
    const options = { viewColumn: fileColumn(), preview: true, preserveFocus: false };
    const title = path.basename(file.uri.fsPath);
    if (file.base) {
      const base = file.base;
      if (file.status === Status.INDEX_ADDED || file.status === Status.UNTRACKED) {
        await vscode.window.showTextDocument(file.uri, options);
      } else if (file.status === Status.DELETED) {
        await vscode.window.showTextDocument(this.git.toGitUri(file.uri, base), options);
      } else {
        await vscode.commands.executeCommand(
          'vscode.diff',
          this.git.toGitUri(file.originalUri ?? file.uri, base),
          file.uri,
          `${title} (${base.slice(0, 8)} ↔ working tree)`,
          options,
        );
      }
      return;
    }
    switch (file.status) {
      case Status.UNTRACKED:
      case Status.INDEX_ADDED:
      case Status.INTENT_TO_ADD:
        await vscode.window.showTextDocument(file.uri, options);
        return;
      case Status.DELETED:
      case Status.INDEX_DELETED:
        await vscode.window.showTextDocument(this.git.toGitUri(file.uri, 'HEAD'), options);
        return;
      default:
        await vscode.commands.executeCommand(
          'vscode.diff',
          this.git.toGitUri(file.uri, 'HEAD'),
          file.uri,
          `${title} (HEAD ↔ working tree)`,
          options,
        );
    }
  }

  dispose(): void {
    clearTimeout(this.renderTimer);
    for (const d of this.repoListeners.values()) {
      d.dispose();
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.emitter.dispose();
  }
}

/** HEAD and the changed files as the git extension sees them: equal fingerprints, equal delta. */
function fingerprint(repo: Repository): string {
  const { state } = repo;
  const changes = [
    ...state.indexChanges,
    ...(state.mergeChanges ?? []),
    ...state.workingTreeChanges,
    ...(state.untrackedChanges ?? []),
  ].map((c) => `${c.status}:${(c.renameUri ?? c.uri).fsPath}`);
  return `${state.HEAD?.name ?? ''}@${state.HEAD?.commit ?? ''}|${changes.sort().join('|')}`;
}

/** Folder tree with single-child folder chains compacted ("src/app/utils"), like the SCM tree view. */
function buildFolderTree(repo: Repository, files: ChangedFile[]): FolderNode {
  const root: FolderNode = { kind: 'folder', repo, label: '', path: '', children: [] };
  for (const file of files) {
    const rel = path.relative(repo.rootUri.fsPath, file.uri.fsPath).split(path.sep);
    let folder = root;
    for (const part of rel.slice(0, -1)) {
      const childPath = folder.path ? `${folder.path}/${part}` : part;
      let child = folder.children.find((c): c is FolderNode => c.kind === 'folder' && c.label === part);
      if (!child) {
        child = { kind: 'folder', repo, label: part, path: childPath, children: [] };
        folder.children.push(child);
      }
      folder = child;
    }
    folder.children.push(file);
  }
  compact(root);
  sortTree(root);
  return root;
}

function compact(folder: FolderNode): void {
  for (let i = 0; i < folder.children.length; i++) {
    let child = folder.children[i];
    if (child.kind !== 'folder') {
      continue;
    }
    while (child.children.length === 1 && child.children[0].kind === 'folder') {
      const only: FolderNode = child.children[0];
      child = { ...only, label: `${child.label}/${only.label}` };
    }
    folder.children[i] = child;
    compact(child);
  }
}

function sortTree(folder: FolderNode): void {
  folder.children.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'folder' ? -1 : 1;
    }
    const nameA = a.kind === 'folder' ? a.label : path.basename(a.uri.fsPath);
    const nameB = b.kind === 'folder' ? b.label : path.basename(b.uri.fsPath);
    return nameA.localeCompare(nameB);
  });
  for (const child of folder.children) {
    if (child.kind === 'folder') {
      sortTree(child);
    }
  }
}
