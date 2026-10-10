import * as vscode from 'vscode';
import { ChangedFile, ChangesView, getGitApi } from './changes';
import { LayoutMode } from './layoutMode';
import { RepoTracker } from './repoTracker';
import { StatusWatcher } from './status';
import { fileColumn, TaskManager } from './tasks';
import { TasksView } from './tasksView';
import { TaskStrip } from './taskStrip';

/** Commands receive either ids (from the task strip / keybindings) or tree nodes (from view menus). */
type TaskArg = string | { task?: { id: string } } | undefined;
type TerminalArg = { task: { id: string }; terminal: { id: string } };

function taskId(arg: TaskArg): string | undefined {
  return typeof arg === 'string' ? arg : arg?.task?.id;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const status = new StatusWatcher(context);
  const tasks = new TaskManager(context, status);
  const layout = new LayoutMode(context);
  const tasksView = new TasksView(tasks);
  const strip = new TaskStrip(tasks, layout);

  // The injected task strip can only talk to us by clicking status bar items, so reordering is
  // "click the move item, click the dragged task, click the drop target" (see taskStrip.ts).
  let pendingMove: { source?: string; timer: NodeJS.Timeout } | undefined;
  const cancelMove = () => {
    clearTimeout(pendingMove?.timer);
    pendingMove = undefined;
  };
  context.subscriptions.push({ dispose: cancelMove });

  context.subscriptions.push(
    status,
    tasks,
    layout,
    tasksView,
    strip,
    vscode.window.createTreeView('aiIde.tasks', { treeDataProvider: tasksView, dragAndDropController: tasksView }),

    vscode.commands.registerCommand('aiIde.newTask', () => tasks.createTask()),
    vscode.commands.registerCommand('aiIde.switchTask', () => tasks.switchTask()),
    vscode.commands.registerCommand('aiIde.activateTask', (arg: TaskArg) => {
      const id = taskId(arg);
      if (id && pendingMove) {
        // Part of a drag in the title-bar strip: first click names the dragged task, second the drop target.
        if (!pendingMove.source) {
          pendingMove.source = id;
          return;
        }
        const source = pendingMove.source;
        cancelMove();
        return tasks.moveTask(source, id);
      }
      return id ? tasks.activate(id) : tasks.switchTask();
    }),
    vscode.commands.registerCommand('aiIde.armMove', () => {
      cancelMove();
      pendingMove = { timer: setTimeout(cancelMove, 3000) };
    }),
    vscode.commands.registerCommand('aiIde.switchToIndex', (index: number) => tasks.switchToIndex(index)),
    vscode.commands.registerCommand('aiIde.renameTask', (arg: TaskArg) => tasks.renameTask(taskId(arg))),
    vscode.commands.registerCommand('aiIde.closeTask', (arg: TaskArg) => tasks.closeTask(taskId(arg))),
    vscode.commands.registerCommand('aiIde.newTerminal', () => tasks.newTerminal()),
    vscode.commands.registerCommand('aiIde.showTerminal', (arg: string | TerminalArg, terminalId?: string) =>
      typeof arg === 'string' ? tasks.showTerminal(arg, terminalId!) : tasks.showTerminal(arg.task.id, arg.terminal.id),
    ),
    vscode.commands.registerCommand('aiIde.killTerminal', (arg: TerminalArg) =>
      tasks.killTerminal(arg.task.id, arg.terminal.id),
    ),
    vscode.commands.registerCommand('aiIde.toggleMode', () => layout.toggle()),
    vscode.commands.registerCommand('aiIde.showExplorer', () => vscode.commands.executeCommand('workbench.view.explorer')),
    vscode.commands.registerCommand('aiIde.showChanges', () =>
      vscode.commands.executeCommand('workbench.view.extension.aiIde'),
    ),
  );

  await layout.initialize();

  const active = tasks.active;
  if (active && vscode.workspace.getConfiguration('aiIde').get<boolean>('resumeActiveTaskOnStartup', true)) {
    // A terminal editor created while the workbench is still restoring comes up as a broken
    // "editor could not be opened" tab next to the real one, so give the restore a moment.
    const timer = setTimeout(() => void tasks.activate(active.id), 2000);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }

  const git = await getGitApi();
  if (git) {
    const changes = new ChangesView(git);
    const treeView = vscode.window.createTreeView('aiIde.changes', { treeDataProvider: changes, showCollapseAll: true });
    changes.attach(treeView);
    const repos = new RepoTracker(context, git, status, tasks);
    context.subscriptions.push(
      changes,
      treeView,
      repos,
      vscode.commands.registerCommand('aiIde.addRepository', async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          openLabel: 'Show in Changes',
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        if (picked?.[0] && !repos.addPath(picked[0].fsPath)) {
          vscode.window.showWarningMessage(`${picked[0].fsPath} is not inside a git repository.`);
        }
      }),
      vscode.commands.registerCommand('aiIde.refreshChanges', () => changes.refresh()),
      vscode.commands.registerCommand('aiIde.openChange', (file: ChangedFile) => changes.openChange(file)),
      vscode.commands.registerCommand('aiIde.openFile', (file: ChangedFile) =>
        vscode.window.showTextDocument(file.uri, { viewColumn: fileColumn(), preview: false }),
      ),
    );
  } else {
    vscode.window.showWarningMessage('AI IDE: the built-in Git extension is disabled, the Changes view is unavailable.');
  }
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
