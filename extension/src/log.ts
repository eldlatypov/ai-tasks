import * as vscode from 'vscode';

/** "AI IDE" channel in the Output panel. */
export const log = vscode.window.createOutputChannel('AI IDE', { log: true });
