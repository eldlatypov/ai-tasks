import * as path from 'path';
import * as vscode from 'vscode';
import { ArtifactsStore } from './artifacts';
import { BackgroundTerminal } from './backgroundTerminal';
import { Task, TaskManager } from './tasks';
import { pendingWorkLines, stateIcon, stateLabel } from './ui';

type Node =
  | { kind: 'task'; task: Task }
  | { kind: 'artifacts'; task: Task }
  | { kind: 'terminal'; task: Task; terminal: BackgroundTerminal };

const TASK_MIME = 'application/vnd.code.tree.aitasks.tasks';

/**
 * Sidebar list of tasks with their artifacts file and terminals: management UI, and the main task switcher when
 * there is no title-bar task strip. Tasks can be dragged to reorder them.
 */
export class TasksView
  implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>, vscode.Disposable
{
  readonly dragMimeTypes = [TASK_MIME];
  readonly dropMimeTypes = [TASK_MIME];
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly tasks: TaskManager,
    private readonly artifacts: ArtifactsStore,
  ) {
    this.subscriptions = [
      tasks.onDidChange(() => this.emitter.fire(undefined)),
      artifacts.onDidChange(() => this.emitter.fire(undefined)),
    ];
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.tasks.all.map((task) => ({ kind: 'task', task }));
    }
    if (node.kind === 'task') {
      return [
        { kind: 'artifacts', task: node.task },
        ...node.task.terminals.map((terminal): Node => ({ kind: 'terminal', task: node.task, terminal })),
      ];
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'task') {
      const { task } = node;
      const active = task === this.tasks.active;
      const item = new vscode.TreeItem(task.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `task:${task.id}`;
      item.iconPath = stateIcon(task.state);
      item.description = `${active ? '● ' : ''}${stateLabel(task.state)} · ${path.basename(task.data.cwd)}`;
      const waitingOn = task.state === 'background' ? `\n${pendingWorkLines(task.background)}` : '';
      item.tooltip = `${task.name}\n${stateLabel(task.state)}${waitingOn}\n${task.data.cwd}`;
      item.contextValue = 'task';
      item.command = { command: 'aiTasks.activateTask', title: 'Open Task', arguments: [task.id] };
      return item;
    }
    if (node.kind === 'artifacts') {
      const { task } = node;
      const links = this.artifacts.linkCount(task.id);
      const item = new vscode.TreeItem('Artifacts', vscode.TreeItemCollapsibleState.None);
      item.id = `artifacts:${task.id}`;
      item.iconPath = new vscode.ThemeIcon('link');
      item.description = links > 0 ? `${links} link${links === 1 ? '' : 's'}` : 'empty';
      item.tooltip = 'Jira issues, merge requests, Confluence pages and the stand of this task';
      item.contextValue = 'artifacts';
      item.command = { command: 'aiTasks.openArtifacts', title: 'Open Artifacts', arguments: [task.id] };
      return item;
    }
    const { task, terminal } = node;
    const item = new vscode.TreeItem(terminal.name, vscode.TreeItemCollapsibleState.None);
    item.id = `terminal:${task.id}:${terminal.id}`;
    item.iconPath = new vscode.ThemeIcon(terminal.kind === 'agent' ? 'hubot' : 'terminal');
    item.description = terminal.isShown ? '' : 'in background';
    item.contextValue = 'terminal';
    item.command = { command: 'aiTasks.showTerminal', title: 'Show Terminal', arguments: [task.id, terminal.id] };
    return item;
  }

  handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
    const task = source.find((n) => n.kind === 'task');
    if (task) {
      data.set(TASK_MIME, new vscode.DataTransferItem(task.task.id));
    }
  }

  async handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
    const sourceId = await data.get(TASK_MIME)?.asString();
    if (!sourceId) {
      return;
    }
    // Dropped on a task or one of its terminals: take that task's place; on empty space: go last.
    const targetId = target?.task.id ?? this.tasks.all[this.tasks.all.length - 1]?.id;
    if (targetId) {
      this.tasks.moveTask(sourceId, targetId);
    }
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.emitter.dispose();
  }
}
