import * as vscode from 'vscode';

/** "AI Tasks" channel in the Output panel. */
export const log = vscode.window.createOutputChannel('AI Tasks', { log: true });
