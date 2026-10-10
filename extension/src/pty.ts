import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// Minimal slice of the node-pty API we use. node-pty ships inside VS Code itself
// (it powers the built-in terminal), so we load that copy instead of bundling our
// own native module: it is guaranteed to match VS Code's Electron ABI.
export interface IPty {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePty {
  spawn(
    file: string,
    args: string[] | string,
    options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: { [key: string]: string } },
  ): IPty;
}

let cached: NodePty | undefined;

export function loadNodePty(): NodePty {
  if (cached) {
    return cached;
  }
  const appRoot = vscode.env.appRoot;
  const candidates = [
    path.join(appRoot, 'node_modules.asar.unpacked', 'node-pty'),
    path.join(appRoot, 'node_modules.asar', 'node-pty'),
    path.join(appRoot, 'node_modules', 'node-pty'),
  ];
  const errors: string[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      // Plain runtime require: esbuild leaves dynamic paths alone.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cached = require(candidate) as NodePty;
      return cached;
    } catch (err) {
      errors.push(`${candidate}: ${String(err)}`);
    }
  }
  throw new Error(`Could not load node-pty from VS Code install (${appRoot}). ${errors.join('; ')}`);
}

/**
 * Markers a Claude Code session leaves in the environment of its children. If this VS Code was
 * started from inside a Claude Code session they would make every task's agent think it is a
 * sub-session (no transcript saving, so no --resume).
 */
const CLAUDE_SESSION_MARKERS =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|MESSAGING_\w+|BRIDGE_\w+|ENTRYPOINT|EXECPATH|SSE_PORT))$/i;

/** Environment for child processes: drop variables that only make sense inside VS Code's own processes. */
export function childEnv(extra: Record<string, string>): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    if (/^(VSCODE_|ELECTRON_)/i.test(key) || key === 'NODE_OPTIONS' || CLAUDE_SESSION_MARKERS.test(key)) {
      continue;
    }
    env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return { ...env, ...extra };
}
