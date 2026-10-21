import * as vscode from 'vscode';
import { ArtifactsStore } from './artifacts';
import { ChangedFile, ChangesMode, ChangesView, getGitApi } from './changes';
import { LayoutMode } from './layoutMode';
import { RepoTracker } from './repoTracker';
import { StatusWatcher } from './status';
import { fileColumn, TaskManager } from './tasks';
import { TasksView } from './tasksView';
import { TaskStrip } from './taskStrip';
import { Updater } from './updater';

/** Commands receive either ids (from the status bar / keybindings) or tree nodes (from view menus). */
type TaskArg = string | { task?: { id: string } } | undefined;
type TerminalArg = { task: { id: string }; terminal: { id: string } };

const CHANGES_MODE_KEY = 'aiTasks.changesMode';

function taskId(arg: TaskArg): string | undefined {
  return typeof arg === 'string' ? arg : arg?.task?.id;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const status = new StatusWatcher(context);
  const artifacts = new ArtifactsStore(context);
  const tasks = new TaskManager(context, status, artifacts);
  const layout = new LayoutMode(context);
  const tasksView = new TasksView(tasks, artifacts);
  const strip = new TaskStrip(tasks, layout);
  const updater = new Updater(context);

  context.subscriptions.push(
    status,
    artifacts,
    tasks,
    layout,
    tasksView,
    strip,
    updater,
    vscode.commands.registerCommand('aiTasks.checkForUpdates', () => updater.check(true)),
    vscode.window.createTreeView('aiTasks.tasks', { treeDataProvider: tasksView, dragAndDropController: tasksView }),

    vscode.commands.registerCommand('aiTasks.newTask', () => tasks.createTask()),
    vscode.commands.registerCommand('aiTasks.switchTask', () => tasks.switchTask()),
    vscode.commands.registerCommand('aiTasks.activateTask', (arg: TaskArg) => {
      const id = taskId(arg);
      return id ? tasks.activate(id) : tasks.switchTask();
    }),
    vscode.commands.registerCommand('aiTasks.switchToIndex', (index: number) => tasks.switchToIndex(index)),
    vscode.commands.registerCommand('aiTasks.renameTask', (arg: TaskArg) => tasks.renameTask(taskId(arg))),
    vscode.commands.registerCommand('aiTasks.closeTask', (arg: TaskArg) => tasks.closeTask(taskId(arg))),
    vscode.commands.registerCommand('aiTasks.newTerminal', () => tasks.newTerminal()),
    vscode.commands.registerCommand('aiTasks.openArtifacts', (arg: TaskArg) => {
      const task = tasks.get(taskId(arg) ?? '') ?? tasks.active;
      if (task) {
        const file = artifacts.ensure(task.id, task.name);
        return vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: fileColumn(), preview: false });
      }
    }),
    vscode.commands.registerCommand('aiTasks.showTerminal', (arg: string | TerminalArg, terminalId?: string) =>
      typeof arg === 'string' ? tasks.showTerminal(arg, terminalId!) : tasks.showTerminal(arg.task.id, arg.terminal.id),
    ),
    vscode.commands.registerCommand('aiTasks.killTerminal', (arg: TerminalArg) =>
      tasks.killTerminal(arg.task.id, arg.terminal.id),
    ),
    vscode.commands.registerCommand('aiTasks.toggleMode', () => layout.toggle()),
    vscode.commands.registerCommand('aiTasks.useAgentLayout', () => layout.useAgent()),
    vscode.commands.registerCommand('aiTasks.useClassicLayout', () => layout.useClassic()),
    vscode.commands.registerCommand('aiTasks.showExplorer', () => vscode.commands.executeCommand('workbench.view.explorer')),
    vscode.commands.registerCommand('aiTasks.showChanges', () =>
      vscode.commands.executeCommand('workbench.view.extension.aiTasks'),
    ),
  );

  await layout.initialize();

  const active = tasks.active;
  if (active && vscode.workspace.getConfiguration('aiTasks').get<boolean>('resumeActiveTaskOnStartup', true)) {
    // A terminal editor created while the workbench is still restoring comes up as a broken
    // "editor could not be opened" tab next to the real one, so give the restore a moment.
    const timer = setTimeout(() => void tasks.activate(active.id), 2000);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }

  const git = await getGitApi();
  if (git) {
    const changes = new ChangesView(git);
    const treeView = vscode.window.createTreeView('aiTasks.changes', { treeDataProvider: changes, showCollapseAll: true });
    changes.setMode(context.workspaceState.get<ChangesMode>(CHANGES_MODE_KEY, 'branch'));
    changes.attach(treeView);
    const setChangesMode = (mode: ChangesMode) => {
      changes.setMode(mode);
      void context.workspaceState.update(CHANGES_MODE_KEY, mode);
    };
    const repos = new RepoTracker(context, git, status, tasks);
    // Only the active task's repositories; with no task, everything.
    changes.setScope(() => (tasks.active ? repos.reposOf(tasks.active.id) : undefined));
    let scopedTaskId = tasks.active?.id;
    context.subscriptions.push(
      changes,
      treeView,
      repos,
      tasks.onDidChange(() => {
        if (tasks.active?.id !== scopedTaskId) {
          scopedTaskId = tasks.active?.id;
          changes.render(0);
        }
      }),
      repos.onDidChangeTaskRepos((taskId) => taskId === tasks.active?.id && changes.render(0)),
      vscode.commands.registerCommand('aiTasks.addRepository', async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          openLabel: 'Show in Changes',
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        if (picked?.[0] && !repos.addPath(picked[0].fsPath, tasks.active?.id)) {
          vscode.window.showWarningMessage(`${picked[0].fsPath} is not inside a git repository.`);
        }
      }),
      vscode.commands.registerCommand('aiTasks.refreshChanges', () => changes.refresh()),
      vscode.commands.registerCommand('aiTasks.showBranchChanges', () => setChangesMode('branch')),
      vscode.commands.registerCommand('aiTasks.showWorkingChanges', () => setChangesMode('working')),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('aiTasks.baseBranch') && changes.refresh()),
      vscode.commands.registerCommand('aiTasks.openChange', (file: ChangedFile) => changes.openChange(file)),
      vscode.commands.registerCommand('aiTasks.openFile', (file: ChangedFile) =>
        vscode.window.showTextDocument(file.uri, { viewColumn: fileColumn(), preview: false }),
      ),
    );
  } else {
    vscode.window.showWarningMessage('AI Tasks: the built-in Git extension is disabled, the Changes view is unavailable.');
  }
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
