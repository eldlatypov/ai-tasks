import * as vscode from 'vscode';
import { AgentState, PendingWork } from './status';

const LABELS: Record<AgentState, string> = {
  thinking: 'AI is working',
  waiting: 'needs your input',
  background: 'waiting for background work',
  done: 'finished',
  idle: 'idle',
  stopped: 'not running',
};

const CODICONS: Record<AgentState, string> = {
  thinking: 'loading~spin',
  waiting: 'bell-dot',
  background: 'telescope',
  done: 'pass-filled',
  idle: 'circle-outline',
  stopped: 'circle-slash',
};

const COLORS: Partial<Record<AgentState, string>> = {
  waiting: 'charts.orange',
  background: 'charts.purple',
  done: 'charts.green',
  thinking: 'charts.blue',
};

export function stateLabel(state: AgentState): string {
  return LABELS[state];
}

/** `$(icon)` syntax for labels and status bar text. */
export function stateCodicon(state: AgentState): string {
  return `$(${CODICONS[state]})`;
}

/** Tooltip lines for what an agent in the background state waits on. */
export function pendingWorkLines(work: readonly PendingWork[]): string {
  // Monitor watches and background commands are both "shell"; the label says which.
  return work.map((w) => `• ${w.label}${w.kind === 'shell' ? '' : ` (${w.kind})`}`).join('\n');
}

export function stateIcon(state: AgentState): vscode.ThemeIcon {
  const color = COLORS[state];
  return new vscode.ThemeIcon(CODICONS[state], color ? new vscode.ThemeColor(color) : undefined);
}
