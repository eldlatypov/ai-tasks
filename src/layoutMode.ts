import * as vscode from 'vscode';

export type Mode = 'agent' | 'classic';

/** User settings the Agent layout changes; Classic restores whatever the user had before. */
function agentSettings(): Record<string, unknown> {
  return {
    'terminal.integrated.defaultLocation': 'editor',
    'scm.defaultViewMode': 'tree',
    'workbench.editor.closeEmptyGroups': true,
    // The chat panel on the right competes with the task's files for space.
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
  };
}

const MODE_KEY = 'aiTasks.mode';
const SNAPSHOT_KEY = 'aiTasks.classicSnapshot';
const AUX_CLOSED_KEY = 'aiTasks.auxiliaryBarClosed';

export class LayoutMode implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Mode>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get mode(): Mode {
    return this.context.globalState.get<Mode>(MODE_KEY, 'agent');
  }

  /** Agent is the default: applied on first start, and settings added in later versions are applied on update. */
  async initialize(): Promise<void> {
    if (this.mode === 'agent') {
      const firstStart = this.context.globalState.get(SNAPSHOT_KEY) === undefined;
      await this.applyAgent(true);
      if (firstStart) {
        await vscode.commands.executeCommand('workbench.view.extension.aiTasks');
      }
      // VS Code opens the chat panel in every new folder; close it once, later it is the user's call.
      if (!this.context.workspaceState.get<boolean>(AUX_CLOSED_KEY)) {
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        await this.context.workspaceState.update(AUX_CLOSED_KEY, true);
      }
    }
    await this.setContext();
  }

  async toggle(): Promise<void> {
    if (this.mode === 'agent') {
      await this.restoreClassic();
      await this.context.globalState.update(MODE_KEY, 'classic');
      await vscode.commands.executeCommand('workbench.view.explorer');
    } else {
      await this.applyAgent();
      await this.context.globalState.update(MODE_KEY, 'agent');
      await vscode.commands.executeCommand('workbench.view.extension.aiTasks');
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    }
    await this.setContext();
    this.emitter.fire(this.mode);
  }

  /** @param onlyNewKeys keep the existing snapshot and apply only settings it does not cover yet */
  private async applyAgent(onlyNewKeys = false): Promise<void> {
    const existing = onlyNewKeys ? this.context.globalState.get<Record<string, unknown>>(SNAPSHOT_KEY) : undefined;
    const snapshot: Record<string, unknown> = { ...existing };
    const config = vscode.workspace.getConfiguration();
    for (const [key, value] of Object.entries(agentSettings())) {
      if (existing && key in existing) {
        continue;
      }
      // null marks "was not set", so restoring removes the key instead of writing a default.
      snapshot[key] = config.inspect(key)?.globalValue ?? null;
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    }
    await this.context.globalState.update(SNAPSHOT_KEY, snapshot);
  }

  private async restoreClassic(): Promise<void> {
    const snapshot = this.context.globalState.get<Record<string, unknown>>(SNAPSHOT_KEY) ?? {};
    const config = vscode.workspace.getConfiguration();
    // Everything the snapshot covers, even if the set of Agent settings has changed since.
    for (const key of Object.keys(snapshot)) {
      const value = snapshot[key];
      await config.update(key, value === null ? undefined : value, vscode.ConfigurationTarget.Global);
    }
  }

  private async setContext(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'aiTasks.agentMode', this.mode === 'agent');
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
