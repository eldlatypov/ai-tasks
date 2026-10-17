import * as vscode from 'vscode';

export type Mode = 'agent' | 'classic';

/**
 * User settings the Agent layout changes; Classic restores whatever the user had before.
 * Nothing here is needed for tasks to work, so they are only applied when the user asks.
 */
export const AGENT_SETTINGS: Readonly<Record<string, unknown>> = {
  // Regular terminals open next to the task terminals instead of in the panel.
  'terminal.integrated.defaultLocation': 'editor',
  // Closing a task's last file leaves just its terminals.
  'workbench.editor.closeEmptyGroups': true,
  'scm.defaultViewMode': 'tree',
  // The chat panel on the right competes with the task's files for space.
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
};

const MODE_KEY = 'aiTasks.mode';
const SNAPSHOT_KEY = 'aiTasks.classicSnapshot';
const OFFERED_KEY = 'aiTasks.layoutOffered';
const AUX_CLOSED_KEY = 'aiTasks.auxiliaryBarClosed';

export class LayoutMode implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Mode>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get mode(): Mode {
    return this.context.globalState.get<Mode>(MODE_KEY, 'classic');
  }

  async initialize(): Promise<void> {
    await this.setContext();
    if (this.mode === 'agent') {
      // VS Code opens the chat panel in every new folder; close it once, later it is the user's call.
      if (!this.context.workspaceState.get<boolean>(AUX_CLOSED_KEY)) {
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        await this.context.workspaceState.update(AUX_CLOSED_KEY, true);
      }
    } else if (!this.context.globalState.get<boolean>(OFFERED_KEY)) {
      await this.context.globalState.update(OFFERED_KEY, true);
      await vscode.commands.executeCommand('workbench.view.extension.aiTasks');
      void this.offer();
    }
  }

  /** Asked once, on the first start: the settings are the user's, so nothing changes without a yes. */
  private async offer(): Promise<void> {
    const apply = 'Apply';
    const details = 'What Changes?';
    const choice = await vscode.window.showInformationMessage(
      'AI Tasks: use the Agent layout? Terminals open as editor tabs, empty editor groups close, the chat side bar stays hidden. ' +
        'You can switch back to your layout at any time from the status bar.',
      apply,
      details,
      'Not Now',
    );
    if (choice === apply) {
      await this.useAgent();
    } else if (choice === details) {
      await vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        { category: `${this.context.extension.id}#aiTasks.start`, step: 'layout' },
        false,
      );
    }
  }

  toggle(): Promise<void> {
    return this.mode === 'agent' ? this.useClassic() : this.useAgent();
  }

  async useAgent(): Promise<void> {
    if (this.mode !== 'agent') {
      await this.applyAgent();
      await this.setMode('agent');
    }
    await vscode.commands.executeCommand('workbench.view.extension.aiTasks');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  }

  async useClassic(): Promise<void> {
    if (this.mode !== 'classic') {
      await this.restoreClassic();
      await this.setMode('classic');
    }
  }

  private async setMode(mode: Mode): Promise<void> {
    await this.context.globalState.update(MODE_KEY, mode);
    await this.setContext();
    this.emitter.fire(mode);
  }

  private async applyAgent(): Promise<void> {
    const snapshot: Record<string, unknown> = {};
    const config = vscode.workspace.getConfiguration();
    for (const [key, value] of Object.entries(AGENT_SETTINGS)) {
      // null marks "was not set", so restoring removes the key instead of writing a default.
      snapshot[key] = config.inspect(key)?.globalValue ?? null;
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    }
    await this.context.globalState.update(SNAPSHOT_KEY, snapshot);
  }

  private async restoreClassic(): Promise<void> {
    const snapshot = this.context.globalState.get<Record<string, unknown>>(SNAPSHOT_KEY) ?? {};
    const config = vscode.workspace.getConfiguration();
    for (const [key, value] of Object.entries(snapshot)) {
      // A setting the user changed by hand since is theirs now; leave it.
      if (key in AGENT_SETTINGS && config.inspect(key)?.globalValue !== AGENT_SETTINGS[key]) {
        continue;
      }
      await config.update(key, value === null ? undefined : value, vscode.ConfigurationTarget.Global);
    }
    await this.context.globalState.update(SNAPSHOT_KEY, undefined);
  }

  private async setContext(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'aiTasks.agentMode', this.mode === 'agent');
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
