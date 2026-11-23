import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { agentKind, codexCommand, isSessionId } from './agent';
import { ArtifactsStore } from './artifacts';
import { BackgroundTerminal, TerminalKind } from './backgroundTerminal';
import { log } from './log';
import { AgentState, PendingWork, StatusRecord, StatusWatcher } from './status';
import { stateLabel } from './ui';

type SavedEditor =
  | { kind: 'text'; uri: string }
  | { kind: 'diff'; original: string; modified: string; title: string };

interface TaskData {
  id: string;
  name: string;
  cwd: string;
  /** Pinned when the task is created. Older records predate agent selection. */
  agentCommand?: string;
  sessionId?: string;
  /** File tabs of the task while it is in the background. */
  editors: SavedEditor[];
}

interface SavedState {
  tasks: TaskData[];
  activeId?: string;
}

export class Task {
  private reportedState: AgentState = 'idle';
  /** What the agent waits on while in the background state. */
  background: PendingWork[] = [];
  readonly terminals: BackgroundTerminal[] = [];
  private shellCounter = 1;

  constructor(readonly data: TaskData) {}

  get state(): AgentState {
    const needsInput = this.agentTerminal?.codexNeedsInput;
    if (needsInput) {
      return 'waiting';
    }
    return needsInput === false && this.reportedState === 'waiting' ? 'thinking' : this.reportedState;
  }

  set state(state: AgentState) {
    this.reportedState = state;
  }

  get id(): string {
    return this.data.id;
  }

  get name(): string {
    return this.data.name;
  }

  get agentTerminal(): BackgroundTerminal | undefined {
    return this.terminals.find((t) => t.kind === 'agent');
  }

  nextShellName(): string {
    this.shellCounter += 1;
    return `Terminal ${this.shellCounter}`;
  }
}

const STORAGE_KEY = 'aiTasks.tasks';
/** Terminals of the active task live in the left editor group, its files to the right (see fileColumn). */
const TERMINAL_COLUMN = vscode.ViewColumn.One;
const TERMINAL_SCHEME = 'vscode-terminal';

export class TaskManager implements vscode.Disposable {
  private tasks: Task[] = [];
  private activeId: string | undefined;
  private switching = false;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires on any change of tasks, their state or their terminals. */
  readonly onDidChange = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [this.changeEmitter];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly status: StatusWatcher,
    private readonly artifacts: ArtifactsStore,
  ) {
    this.restore();
    this.disposables.push(
      status.onStatus(({ taskId, record }) => this.applyStatus(taskId, record)),
      vscode.window.tabGroups.onDidChangeTabs((e) => void this.keepFilesOutOfTerminalGroup([...e.opened, ...e.changed])),
    );
  }

  get all(): readonly Task[] {
    return this.tasks;
  }

  get active(): Task | undefined {
    return this.tasks.find((t) => t.id === this.activeId);
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  async createTask(): Promise<void> {
    const cwd = await this.pickFolder();
    if (!cwd) {
      return;
    }
    const defaultName = `Task ${this.tasks.length + 1}`;
    const name = await vscode.window.showInputBox({
      title: 'New task',
      prompt: `Agent will start in ${cwd}`,
      value: defaultName,
      valueSelection: [0, defaultName.length],
    });
    if (name === undefined) {
      return;
    }
    const agentCommand = defaultAgentCommand();
    const task = new Task({ id: crypto.randomUUID().slice(0, 8), name: name.trim() || defaultName, cwd, agentCommand, editors: [] });
    this.tasks.push(task);
    this.save();
    await this.activate(task.id);
  }

  /** Makes a task the current one: hides the previous task's terminals and files, shows this one's. */
  async activate(id: string): Promise<void> {
    const task = this.get(id);
    if (!task || this.switching) {
      return;
    }
    this.switching = true;
    try {
      const prev = this.active;
      if (prev && prev !== task) {
        prev.data.editors = this.captureEditors();
        await this.closeFileEditors();
        for (const t of prev.terminals) {
          t.hide();
        }
      }
      this.activeId = task.id;
      await this.closeBrokenTerminalTabs();

      if (!task.terminals.some((t) => !t.hasExited) && !this.startAgent(task)) {
        return;
      }
      if (task.state === 'done') {
        task.state = 'idle';
      }

      // Background terminals first, the agent last so that it ends up focused.
      const focusTarget = task.agentTerminal ?? task.terminals[task.terminals.length - 1];
      for (const t of task.terminals) {
        if (t !== focusTarget) {
          t.show(TERMINAL_COLUMN, true);
        }
      }
      focusTarget?.show(TERMINAL_COLUMN, false);
      // The terminal tab shows up in the tabs API a moment later; file placement depends on it.
      await waitForTerminalTab();

      if (prev !== task) {
        await this.restoreEditors(task.data.editors);
        task.data.editors = [];
      }
      await this.keepFilesOutOfTerminalGroup(vscode.window.tabGroups.all.flatMap((g) => g.tabs), true);
      focusTarget?.terminal?.show(false);
    } finally {
      this.switching = false;
      this.save();
      this.changeEmitter.fire();
    }
  }

  async switchTask(): Promise<void> {
    if (this.tasks.length === 0) {
      return this.createTask();
    }
    const items = this.tasks.map((t) => ({
      label: `${t.id === this.activeId ? '$(arrow-right) ' : ''}${t.name}`,
      description: stateLabel(t.state),
      detail: t.data.cwd,
      id: t.id,
    }));
    const pick = await vscode.window.showQuickPick(items, { title: 'Switch task', matchOnDetail: true });
    if (pick) {
      await this.activate(pick.id);
    }
  }

  async switchToIndex(index: number): Promise<void> {
    const task = this.tasks[index];
    if (task) {
      await this.activate(task.id);
    }
  }

  /** Puts `sourceId` at the position of `targetId` (like dropping a tab onto another tab). */
  moveTask(sourceId: string, targetId: string): void {
    const from = this.tasks.findIndex((t) => t.id === sourceId);
    const to = this.tasks.findIndex((t) => t.id === targetId);
    if (from < 0 || to < 0 || from === to) {
      return;
    }
    const [task] = this.tasks.splice(from, 1);
    this.tasks.splice(to, 0, task);
    this.save();
    this.changeEmitter.fire();
  }

  async renameTask(id?: string): Promise<void> {
    const task = id ? this.get(id) : this.active;
    if (!task) {
      return;
    }
    const name = await vscode.window.showInputBox({ title: 'Rename task', value: task.name });
    if (name?.trim()) {
      task.data.name = name.trim();
      this.save();
      this.changeEmitter.fire();
    }
  }

  async closeTask(id?: string): Promise<void> {
    const task = id ? this.get(id) : this.active;
    if (!task) {
      return;
    }
    const running = task.terminals.filter((t) => !t.hasExited).length;
    if (running > 0) {
      const answer = await vscode.window.showWarningMessage(
        `Close task "${task.name}"?`,
        { modal: true, detail: `${running} terminal(s) will be stopped.` },
        'Close Task',
      );
      if (answer !== 'Close Task') {
        return;
      }
    }
    const index = this.tasks.indexOf(task);
    const wasActive = task.id === this.activeId;
    if (wasActive) {
      await this.closeFileEditors();
      this.activeId = undefined;
    }
    for (const t of [...task.terminals]) {
      t.dispose();
    }
    this.tasks.splice(index, 1);
    this.status.clear(task.id);
    this.save();
    this.changeEmitter.fire();

    const next = this.tasks[Math.min(index, this.tasks.length - 1)];
    if (wasActive && next) {
      await this.activate(next.id);
    }
  }

  async newTerminal(): Promise<void> {
    const task = this.active;
    if (!task) {
      return this.createTask();
    }
    const term = this.spawn(task, 'shell', task.nextShellName());
    term?.show(TERMINAL_COLUMN, false);
  }

  async showTerminal(taskId: string, terminalId: string): Promise<void> {
    if (taskId !== this.activeId) {
      await this.activate(taskId);
    }
    this.get(taskId)
      ?.terminals.find((t) => t.id === terminalId)
      ?.show(TERMINAL_COLUMN, false);
  }

  killTerminal(taskId: string, terminalId: string): void {
    this.get(taskId)
      ?.terminals.find((t) => t.id === terminalId)
      ?.kill(); // onExit removes it from the task and disposes its view
  }

  private startAgent(task: Task): boolean {
    const command = task.data.agentCommand ?? defaultAgentCommand();
    let initial: string | undefined;
    if (command) {
      initial = command;
      if (agentKind(command) === 'codex') {
        initial = codexCommand(command, task.data.sessionId);
      } else if (agentKind(command) === 'claude') {
        initial += ` --settings "${this.status.claudeSettingsPath.replace(/\\/g, '/')}"`;
        if (isSessionId(task.data.sessionId) && claudeTranscriptExists(task.data.sessionId)) {
          initial += ` --resume ${task.data.sessionId}`;
        }
      }
    }
    task.state = 'idle';
    return this.spawn(task, 'agent', 'Agent', initial) !== undefined;
  }

  private spawn(task: Task, kind: TerminalKind, name: string, initialCommand?: string): BackgroundTerminal | undefined {
    const config = vscode.workspace.getConfiguration('aiTasks');
    const isCodex = kind === 'agent' && agentKind(task.data.agentCommand ?? '') === 'codex';
    let cwd = task.data.cwd;
    if (!fs.existsSync(cwd)) {
      log.warn(`Folder ${cwd} no longer exists. Starting the terminal in the workspace root.`);
      cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    }
    let term: BackgroundTerminal;
    try {
      term = new BackgroundTerminal({
        id: crypto.randomUUID().slice(0, 8),
        name,
        kind,
        cwd,
        ...shellCommand(config),
        env:
          kind === 'agent'
            ? {
                AI_TASKS_TASK: task.id,
                AI_TASKS_STATUS_FILE: this.status.statusFileFor(task.id),
                AI_TASKS_ARTIFACTS_FILE: this.artifacts.ensure(task.id, task.name),
                ...(isCodex ? this.status.codexEnvironment() : {}),
              }
            : { AI_TASKS_TASK: task.id },
        initialCommand,
        onDidChangeCodexStatus: isCodex ? () => this.changeEmitter.fire() : undefined,
      });
    } catch (err) {
      log.error('cannot start terminal', err);
      vscode.window.setStatusBarMessage('AI Tasks could not start the terminal. See the AI Tasks output.', 6000);
      return undefined;
    }
    task.terminals.push(term);
    term.onExit(() => {
      const i = task.terminals.indexOf(term);
      if (i >= 0) {
        task.terminals.splice(i, 1);
      }
      if (kind === 'agent') {
        task.state = 'stopped';
      }
      term.dispose();
      this.changeEmitter.fire();
    });
    term.onInput(() => {
      // The user is looking at the task and typing: whatever finished is now seen.
      if (kind === 'agent' && task.state === 'done') {
        task.state = 'idle';
        this.changeEmitter.fire();
      }
    });
    term.onDidChangeView(() => this.changeEmitter.fire());
    this.changeEmitter.fire();
    return term;
  }

  private applyStatus(taskId: string, record: StatusRecord): void {
    const task = this.get(taskId);
    if (!task) {
      return;
    }
    if (record.sessionId && record.sessionId !== task.data.sessionId) {
      task.data.sessionId = record.sessionId;
      this.save();
    }
    task.state = record.state;
    task.background = record.background ?? [];
    this.changeEmitter.fire();
  }

  // --- editors -------------------------------------------------------------------------------

  private captureEditors(): SavedEditor[] {
    const result: SavedEditor[] = [];
    const activeLast: SavedEditor[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const saved = toSavedEditor(tab);
        if (saved) {
          (tab.isActive ? activeLast : result).push(saved);
        }
      }
    }
    return [...result, ...activeLast];
  }

  private async closeFileEditors(): Promise<void> {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => toSavedEditor(t) && !t.isDirty);
    if (tabs.length > 0) {
      await vscode.window.tabGroups.close(tabs, true);
    }
  }

  /**
   * When VS Code fails to revive a terminal editor (e.g. after it was killed), it can come back as a
   * text tab for the `vscode-terminal:` resource that shows "editor could not be opened". Close those.
   */
  private async closeBrokenTerminalTabs(): Promise<void> {
    const broken = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.scheme === TERMINAL_SCHEME);
    if (broken.length > 0) {
      log.info(`closing ${broken.length} broken terminal tab(s)`);
      await vscode.window.tabGroups.close(broken, true);
    }
  }

  private async restoreEditors(editors: SavedEditor[]): Promise<void> {
    for (const editor of editors) {
      if (editor.kind === 'text' && editor.uri.startsWith(`${TERMINAL_SCHEME}:`)) {
        continue; // saved by an older version
      }
      const options = { viewColumn: fileColumn(), preserveFocus: true, preview: false };
      try {
        if (editor.kind === 'text') {
          await vscode.window.showTextDocument(vscode.Uri.parse(editor.uri), options);
        } else {
          await vscode.commands.executeCommand(
            'vscode.diff',
            vscode.Uri.parse(editor.original),
            vscode.Uri.parse(editor.modified),
            editor.title,
            options,
          );
        }
      } catch {
        // file was deleted in the meantime
      }
    }
  }

  /** Files opened next to the task's terminals (e.g. from the Explorer) are moved into the file column. */
  private async keepFilesOutOfTerminalGroup(tabs: readonly vscode.Tab[], force = false): Promise<void> {
    if ((this.switching && !force) || !this.active) {
      return;
    }
    for (const tab of tabs) {
      const saved = toSavedEditor(tab);
      if (!saved || tab.isDirty || !tab.group.tabs.some((t) => t.input instanceof vscode.TabInputTerminal)) {
        continue;
      }
      const wasActive = tab.isActive;
      await vscode.window.tabGroups.close(tab, true);
      const options = { viewColumn: fileColumn(), preserveFocus: !wasActive || force, preview: tab.isPreview };
      if (saved.kind === 'text') {
        await vscode.window.showTextDocument(vscode.Uri.parse(saved.uri), options);
      } else {
        await vscode.commands.executeCommand(
          'vscode.diff',
          vscode.Uri.parse(saved.original),
          vscode.Uri.parse(saved.modified),
          saved.title,
          options,
        );
      }
    }
  }

  // --- persistence ---------------------------------------------------------------------------

  private restore(): void {
    const saved = this.context.workspaceState.get<SavedState>(STORAGE_KEY);
    if (!saved) {
      return;
    }
    const needsMigration = saved.tasks.some(data => data.agentCommand === undefined);
    this.tasks = saved.tasks.map((data) => {
      if (data.agentCommand === undefined) {
        const configured = defaultAgentCommand();
        // Only Claude tasks produced session ids before Codex integration.
        data.agentCommand = data.sessionId && agentKind(configured) !== 'claude' ? 'claude' : configured;
      }
      const task = new Task(data);
      task.state = 'stopped';
      return task;
    });
    // VS Code restores the active task's file tabs itself; its terminals start on first activation.
    this.activeId = saved.activeId;
    if (needsMigration) this.save();
  }

  private save(): void {
    const state: SavedState = { tasks: this.tasks.map((t) => t.data), activeId: this.activeId };
    void this.context.workspaceState.update(STORAGE_KEY, state);
  }

  private async pickFolder(): Promise<string | undefined> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const folders: string[] = [];
    for (const root of roots) {
      folders.push(root);
      for (const entry of safeReaddir(root)) {
        const full = path.join(root, entry);
        if (fs.existsSync(path.join(full, '.git'))) {
          folders.push(full);
        }
      }
    }
    const current = this.active?.data.cwd;
    folders.sort((a, b) => Number(b === current) - Number(a === current));

    const browse = { label: '$(folder-opened) Browse…', description: '', path: '' };
    const pick = await vscode.window.showQuickPick(
      [...folders.map((f) => ({ label: path.basename(f), description: f, path: f })), browse],
      { title: 'New task: where should the agent work?', matchOnDescription: true },
    );
    if (!pick) {
      return undefined;
    }
    if (pick !== browse) {
      return pick.path;
    }
    const chosen = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true });
    return chosen?.[0]?.fsPath;
  }

  dispose(): void {
    for (const task of this.tasks) {
      for (const t of task.terminals) {
        t.dispose();
      }
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function defaultAgentCommand(): string {
  return vscode.workspace.getConfiguration('aiTasks').get<string>('agentCommand', 'claude').trim();
}

export async function selectDefaultAgent(): Promise<void> {
  const config = vscode.workspace.getConfiguration('aiTasks');
  const current = defaultAgentCommand();
  const choices = [{ label: 'Codex', command: 'codex' }, { label: 'Claude Code', command: 'claude' }];
  const pick = await vscode.window.showQuickPick(choices.map(item => ({
    ...item, description: agentKind(current) === item.command ? 'Current default' : undefined,
  })), { title: 'Default agent for new tasks' });
  if (pick && agentKind(current) !== pick.command) {
    const target = config.inspect('agentCommand')?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('agentCommand', pick.command, target);
  }
}

/**
 * Column for files: an existing group without terminals, or a new group to the right of the
 * terminals. (A fixed ViewColumn.Two is not enough: after restarts or closed groups the
 * terminals are not always in the first group.)
 */
export function fileColumn(): vscode.ViewColumn {
  const groups = vscode.window.tabGroups.all;
  const hasTerminal = (g: vscode.TabGroup) => g.tabs.some((t) => t.input instanceof vscode.TabInputTerminal);
  if (!groups.some(hasTerminal)) {
    return vscode.ViewColumn.Active;
  }
  const fileGroup = groups.find((g) => !hasTerminal(g));
  return fileGroup ? fileGroup.viewColumn : ((Math.max(...groups.map((g) => g.viewColumn)) + 1) as vscode.ViewColumn);
}

function waitForTerminalTab(timeoutMs = 2000): Promise<void> {
  const present = () =>
    vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputTerminal));
  if (present()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      listener.dispose();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const listener = vscode.window.tabGroups.onDidChangeTabs(() => present() && done());
  });
}

function toSavedEditor(tab: vscode.Tab): SavedEditor | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText && input.uri.scheme !== TERMINAL_SCHEME) {
    return { kind: 'text', uri: input.uri.toString() };
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return { kind: 'diff', original: input.original.toString(), modified: input.modified.toString(), title: tab.label };
  }
  return undefined;
}

/** Claude Code keeps transcripts in ~/.claude/projects/<project>/<session>.jsonl; `--resume` fails without one. */
function claudeTranscriptExists(sessionId: string): boolean {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  return safeReaddir(projects).some((dir) => fs.existsSync(path.join(projects, dir, `${sessionId}.jsonl`)));
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The `aiTasks.shell` setting, or the platform's usual shell when it is empty. */
function shellCommand(config: vscode.WorkspaceConfiguration): { shell: string; shellArgs: string[] } {
  const shell = config.get<string>('shell', '').trim();
  const args = config.get<string[]>('shellArgs', []);
  if (shell) {
    return { shell, shellArgs: args };
  }
  if (process.platform === 'win32') {
    return { shell: 'powershell.exe', shellArgs: args.length > 0 ? args : ['-NoLogo'] };
  }
  // A login shell on macOS, as VS Code does, so PATH has what the user's profile adds (e.g. claude).
  return { shell: process.env.SHELL || '/bin/bash', shellArgs: args.length > 0 ? args : process.platform === 'darwin' ? ['-l'] : [] };
}
