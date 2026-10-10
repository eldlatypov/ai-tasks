import * as path from 'path';
import * as vscode from 'vscode';
import { BackgroundTerminal } from './backgroundTerminal';
import { Task, TaskManager } from './tasks';
import { stateIcon, stateLabel } from './ui';

type Node = { kind: 'task'; task: Task } | { kind: 'terminal'; task: Task; terminal: BackgroundTerminal };

/** Sidebar list of tasks and their terminals: management UI, and a fallback when the title-bar task strip is off. */
export class TasksView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
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

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
