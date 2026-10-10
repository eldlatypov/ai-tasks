import * as path from 'path';
import * as vscode from 'vscode';
import { BackgroundTerminal } from './backgroundTerminal';
import { Task, TaskManager } from './tasks';
import { stateIcon, stateLabel } from './ui';

type Node = { kind: 'task'; task: Task } | { kind: 'terminal'; task: Task; terminal: BackgroundTerminal };

const TASK_MIME = 'application/vnd.code.tree.aiide.tasks';

/**
 * Sidebar list of tasks and their terminals: management UI, and the main task switcher when
 * there is no title-bar task strip. Tasks can be dragged to reorder them.
 */
export class TasksView
  implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>, vscode.Disposable
{
  readonly dragMimeTypes = [TASK_MIME];
  readonly dropMimeTypes = [TASK_MIME];
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly tasks: TaskManager) {
    this.subscription = tasks.onDidChange(() => this.emitter.fire(undefined));
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.tasks.all.map((task) => ({ kind: 'task', task }));
    }
    if (node.kind === 'task') {
      return node.task.terminals.map((terminal) => ({ kind: 'terminal', task: node.task, terminal }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'task') {
      const { task } = node;
      const active = task === this.tasks.active;
      const item = new vscode.TreeItem(
        task.name,
        task.terminals.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      );
      item.id = `task:${task.id}`;
      item.iconPath = stateIcon(task.state);
      item.description = `${active ? '● ' : ''}${stateLabel(task.state)} · ${path.basename(task.data.cwd)}`;
      item.tooltip = `${task.name}\n${stateLabel(task.state)}\n${task.data.cwd}`;
      item.contextValue = 'task';
      item.command = { command: 'aiIde.activateTask', title: 'Open Task', arguments: [task.id] };
      return item;
    }
    const { task, terminal } = node;
    const item = new vscode.TreeItem(terminal.name, vscode.TreeItemCollapsibleState.None);
    item.id = `terminal:${task.id}:${terminal.id}`;
    item.iconPath = new vscode.ThemeIcon(terminal.kind === 'agent' ? 'hubot' : 'terminal');
    item.description = terminal.isShown ? '' : 'in background';
    item.contextValue = 'terminal';
    item.command = { command: 'aiIde.showTerminal', title: 'Show Terminal', arguments: [task.id, terminal.id] };
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
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
