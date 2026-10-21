import * as vscode from 'vscode';
import { LayoutMode } from './layoutMode';
import { TaskManager } from './tasks';
import { pendingWorkLines, stateCodicon, stateLabel } from './ui';

/** Tasks as status bar items: a task switcher that is always in view, plus the layout switch. */
export class TaskStrip implements vscode.Disposable {
  private readonly items = new Map<string, vscode.StatusBarItem>();
  private readonly newTaskItem: vscode.StatusBarItem;
  private readonly modeItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly tasks: TaskManager,
    private readonly layout: LayoutMode,
  ) {
    this.newTaskItem = vscode.window.createStatusBarItem('new-task', vscode.StatusBarAlignment.Left, 10000 - 999);
    this.newTaskItem.name = 'AI Tasks: New Task';
    this.newTaskItem.text = '$(add)';
    this.newTaskItem.tooltip = 'New task (Ctrl+Alt+N)';
    this.newTaskItem.command = 'aiTasks.newTask';

    this.modeItem = vscode.window.createStatusBarItem('mode', vscode.StatusBarAlignment.Right, -10000);
    this.modeItem.name = 'AI Tasks: Layout';
    this.modeItem.command = 'aiTasks.toggleMode';

    this.disposables.push(
      this.newTaskItem,
      this.modeItem,
      tasks.onDidChange(() => this.render()),
      layout.onDidChange(() => this.render()),
    );
    this.render();
  }

  private render(): void {
    const agent = this.layout.mode === 'agent';
    this.modeItem.text = agent ? '$(layout) Agent' : '$(layout) Classic';
    this.modeItem.tooltip = agent
      ? 'AI Tasks: Agent layout is on. Click to restore your own layout settings.'
      : 'AI Tasks: click for the Agent layout (terminals as editor tabs, empty groups close, chat side bar hidden).';
    this.modeItem.show();

    const seen = new Set<string>();
    this.tasks.all.forEach((task, index) => {
      seen.add(task.id);
      let item = this.items.get(task.id);
      // Priority fixes the order, so an item is recreated when its position changes. The position
      // is part of the id too: VS Code puts an item that reuses an id back where it was.
      const priority = 10000 - index;
      if (item && item.priority !== priority) {
        item.dispose();
        item = undefined;
      }
      if (!item) {
        item = vscode.window.createStatusBarItem(`task-${index}-${task.id}`, vscode.StatusBarAlignment.Left, priority);
        item.name = `AI Tasks Task: ${task.name}`;
        this.items.set(task.id, item);
      }
      const active = task === this.tasks.active;
      item.text = `${stateCodicon(task.state)} ${active ? `[${task.name}]` : task.name}`;
      const waitingOn = task.state === 'background' ? `\n${pendingWorkLines(task.background)}` : '';
      item.tooltip = `${task.name} — ${stateLabel(task.state)}${waitingOn}\n${task.data.cwd}${index < 9 ? `\nCtrl+Alt+${index + 1}` : ''}`;
      item.command = { command: 'aiTasks.activateTask', title: 'Open Task', arguments: [task.id] };
      item.backgroundColor = task.state === 'waiting' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      item.show();
    });
    for (const [id, item] of this.items) {
      if (!seen.has(id)) {
        item.dispose();
        this.items.delete(id);
      }
    }
    this.newTaskItem.show();
  }

  dispose(): void {
    for (const item of this.items.values()) {
      item.dispose();
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
