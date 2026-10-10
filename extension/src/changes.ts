import * as path from 'path';
import * as vscode from 'vscode';
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
  readonly HEAD: { readonly name?: string } | undefined;
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
}

interface RepoNode {
  kind: 'repo';
  repo: Repository;
  files: ChangedFile[];
}

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

/** "Only changes" explorer: changed files of every repository in the workspace, sibling repos included. */
export class ChangesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly repoListeners = new Map<Repository, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private treeView: vscode.TreeView<Node> | undefined;

  constructor(readonly git: GitAPI) {
    for (const repo of git.repositories) {
      this.track(repo);
    }
    this.disposables.push(
      git.onDidOpenRepository((repo) => {
        this.track(repo);
        this.refresh();
      }),
      git.onDidCloseRepository((repo) => {
        this.repoListeners.get(repo)?.dispose();
        this.repoListeners.delete(repo);
        this.refresh();
      }),
    );
  }

  attach(treeView: vscode.TreeView<Node>): void {
    this.treeView = treeView;
    this.updateBadge();
  }

  refresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.emitter.fire(undefined);
      this.updateBadge();
    }, 100);
  }

  private track(repo: Repository): void {
    if (!this.repoListeners.has(repo)) {
      this.repoListeners.set(
        repo,
        repo.state.onDidChange(() => this.refresh()),
      );
    }
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

  private repos(): RepoNode[] {
    return this.git.repositories
      .map((repo) => ({ kind: 'repo' as const, repo, files: this.changedFiles(repo) }))
      .filter((node) => node.files.length > 0)
      .sort((a, b) => path.basename(a.repo.rootUri.fsPath).localeCompare(path.basename(b.repo.rootUri.fsPath)));
  }

  private updateBadge(): void {
    if (!this.treeView) {
      return;
    }
    const total = this.repos().reduce((sum, r) => sum + r.files.length, 0);
    this.treeView.badge = total > 0 ? { value: total, tooltip: `${total} changed file(s)` } : undefined;
    this.treeView.message =
      total === 0
        ? `No changes in ${this.git.repositories.length} tracked repositor${this.git.repositories.length === 1 ? 'y' : 'ies'}.`
        : undefined;
  }

  getChildren(node?: Node): Node[] {
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
      const item = new vscode.TreeItem(path.basename(node.repo.rootUri.fsPath), vscode.TreeItemCollapsibleState.Expanded);
      item.id = `repo:${node.repo.rootUri.fsPath}`;
      item.iconPath = new vscode.ThemeIcon('repo');
      const branch = node.repo.state.HEAD?.name;
      item.description = `${node.files.length} change${node.files.length === 1 ? '' : 's'}${branch ? ` · ${branch}` : ''}`;
      item.tooltip = node.repo.rootUri.fsPath;
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
    item.id = `file:${node.uri.fsPath}`;
    item.description = STATUS_LETTER[node.status] ?? '';
    item.tooltip = `${path.relative(node.repo.rootUri.fsPath, node.uri.fsPath)} — ${item.description}`;
    item.contextValue = 'change';
    item.command = { command: 'aiIde.openChange', title: 'Open Changes', arguments: [node] };
    return item;
  }

  /** Diff against HEAD for modified files; plain file for new ones; HEAD version for deleted ones. */
  async openChange(file: ChangedFile): Promise<void> {
    const options = { viewColumn: fileColumn(), preview: true, preserveFocus: false };
    const title = path.basename(file.uri.fsPath);
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
    clearTimeout(this.refreshTimer);
    for (const d of this.repoListeners.values()) {
      d.dispose();
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.emitter.dispose();
  }
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
