import * as vscode from 'vscode';
import { LayoutMode } from './layoutMode';
import { TaskManager } from './tasks';
import { stateCodicon, stateLabel } from './ui';

/**
 * Tasks as status bar items.
 *
 * They are the fallback task switcher, and at the same time the data source for the task strip
 * that the injected workbench script (injected/taskstrip.js) draws in the title bar: it reads the
 * `aiide:` aria-labels below, renders tabs, and forwards clicks to these items. That keeps the
 * injected part dumb and lets everything degrade to plain status bar items if it ever breaks.
 *
 * aria-label formats:
 *   aiide:task:<id>:<state>:<active 0|1>:<index>:<encoded name>
 *     (the index gives the order: VS Code keeps a re-created item at its old status bar position)
 *   aiide:new
 *   aiide:move      (arms a reorder: the next two task clicks are "dragged task", "drop target")
 *   aiide:mode:<agent|classic>
 */
export class TaskStrip implements vscode.Disposable {
  private readonly items = new Map<string, vscode.StatusBarItem>();
  private readonly newTaskItem: vscode.StatusBarItem;
  private readonly moveItem: vscode.StatusBarItem;
  private readonly modeItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly tasks: TaskManager,
    private readonly layout: LayoutMode,
  ) {
    this.newTaskItem = vscode.window.createStatusBarItem('new-task', vscode.StatusBarAlignment.Left, 10000 - 999);
    this.newTaskItem.name = 'AI IDE: New Task';
    this.newTaskItem.text = '$(add)';
    this.newTaskItem.tooltip = 'New task (Ctrl+Alt+N)';
    this.newTaskItem.command = 'aiIde.newTask';
    this.newTaskItem.accessibilityInformation = { label: 'aiide:new' };

    // Only for the title-bar strip; it hides this item.
    this.moveItem = vscode.window.createStatusBarItem('move-task', vscode.StatusBarAlignment.Left, 10000 - 1000);
    this.moveItem.name = 'AI IDE: Reorder Tasks';
    this.moveItem.text = '$(arrow-swap)';
    this.moveItem.command = 'aiIde.armMove';
    this.moveItem.accessibilityInformation = { label: 'aiide:move' };

    this.modeItem = vscode.window.createStatusBarItem('mode', vscode.StatusBarAlignment.Right, -10000);
    this.modeItem.name = 'AI IDE: Layout';
    this.modeItem.command = 'aiIde.toggleMode';

    this.disposables.push(
      this.newTaskItem,
      this.moveItem,
      this.modeItem,
      tasks.onDidChange(() => this.render()),
      layout.onDidChange(() => this.render()),
    );
    this.render();
  }

  private render(): void {
    const agent = this.layout.mode === 'agent';
    this.modeItem.text = agent ? '$(layout) Agent' : '$(layout) Classic';
    this.modeItem.tooltip = agent ? 'Agent layout is on. Click for the classic VS Code layout.' : 'Click for the Agent layout.';
    this.modeItem.accessibilityInformation = { label: `aiide:mode:${this.layout.mode}` };
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
        item.name = `AI IDE Task: ${task.name}`;
        this.items.set(task.id, item);
      }
      const active = task === this.tasks.active;
      item.text = `${stateCodicon(task.state)} ${active ? `[${task.name}]` : task.name}`;
      item.tooltip = `${task.name} — ${stateLabel(task.state)}\n${task.data.cwd}${index < 9 ? `\nCtrl+Alt+${index + 1}` : ''}`;
      item.command = { command: 'aiIde.activateTask', title: 'Open Task', arguments: [task.id] };
      item.accessibilityInformation = {
        label: `aiide:task:${task.id}:${task.state}:${active ? 1 : 0}:${index}:${encodeURIComponent(task.name)}`,
      };
      item.backgroundColor = task.state === 'waiting' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      if (agent) {
        item.show();
      } else {
        item.hide();
      }
    });
    for (const [id, item] of this.items) {
      if (!seen.has(id)) {
        item.dispose();
        this.items.delete(id);
      }
    }
    for (const item of [this.newTaskItem, this.moveItem]) {
      if (agent) {
        item.show();
      } else {
        item.hide();
      }
    }
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
