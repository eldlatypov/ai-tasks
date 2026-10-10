import * as vscode from 'vscode';
import { AgentState } from './status';

const LABELS: Record<AgentState, string> = {
  thinking: 'AI is working',
  waiting: 'needs your input',
  done: 'finished',
  idle: 'idle',
  stopped: 'not running',
};

const CODICONS: Record<AgentState, string> = {
  thinking: 'loading~spin',
  waiting: 'bell-dot',
  done: 'pass-filled',
  idle: 'circle-outline',
  stopped: 'circle-slash',
};

const COLORS: Partial<Record<AgentState, string>> = {
  waiting: 'charts.orange',
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

export function stateIcon(state: AgentState): vscode.ThemeIcon {
  const color = COLORS[state];
  return new vscode.ThemeIcon(CODICONS[state], color ? new vscode.ThemeColor(color) : undefined);
}
