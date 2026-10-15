import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * - thinking: the agent is working on a turn
 * - waiting:  the agent is blocked on the user (permission prompt, question)
 * - done:     the agent finished its turn and the user has not looked yet
 * - idle:     nothing is happening
 * - stopped:  no process (e.g. after a window reload, before the task is reopened)
 */
export type AgentState = 'thinking' | 'waiting' | 'done' | 'idle' | 'stopped';

/**
 * Per-task journal of paths the agent wrote to. Older versions kept reads too, in `.touched`
 * files; those are ignored so a task that only read a repo does not get its MR delta.
 */
const JOURNAL = '.writes';

export interface StatusRecord {
  state: AgentState;
  event?: string;
  sessionId?: string;
  message?: string;
  ts: number;
}

/** Writes the Claude Code settings file with our hooks and watches the per-task status files they produce. */
export class StatusWatcher implements vscode.Disposable {
  readonly statusDir: string;
  readonly claudeSettingsPath: string;

  private readonly emitter = new vscode.EventEmitter<{ taskId: string; record: StatusRecord }>();
  readonly onStatus = this.emitter.event;

  private readonly touchedEmitter = new vscode.EventEmitter<{ taskId: string; paths: string[] }>();
  /**
   * Paths (files, folders) a task's agent wrote to, from the hook's .writes files. The status
   * dir is shared by all windows: listeners must ignore tasks that are not theirs.
   */
  readonly onTouched = this.touchedEmitter.event;
  private readonly touchedOffsets = new Map<string, number>();

  private watcher: fs.FSWatcher | undefined;
  private readonly lastTs = new Map<string, number>();
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(context: vscode.ExtensionContext) {
    const storage = context.globalStorageUri.fsPath;
    this.statusDir = path.join(storage, 'status');
    this.claudeSettingsPath = path.join(storage, 'claude-hooks.json');
    fs.mkdirSync(this.statusDir, { recursive: true });
    this.writeClaudeSettings(path.join(context.extensionPath, 'hooks', 'hook.js'));
    this.watch();
  }

  statusFileFor(taskId: string): string {
    return path.join(this.statusDir, `${taskId}.json`);
  }

  clear(taskId: string): void {
    fs.rmSync(this.statusFileFor(taskId), { force: true });
    for (const ext of [JOURNAL, '.touched']) {
      fs.rmSync(path.join(this.statusDir, `${taskId}${ext}`), { force: true });
    }
    this.touchedOffsets.delete(`${taskId}${JOURNAL}`);
    this.lastTs.delete(taskId);
  }

  private writeClaudeSettings(hookScript: string): void {
    // Forward slashes work both in cmd and in the Git Bash that Claude Code uses on Windows.
    const script = hookScript.replace(/\\/g, '/');
    const hook = (state: string) => [{ hooks: [{ type: 'command', command: `node "${script}" ${state}` }] }];
    const settings = {
      hooks: {
        SessionStart: hook('idle'),
        UserPromptSubmit: hook('thinking'),
        PostToolUse: hook('thinking'),
        Notification: hook('notify'),
        Stop: hook('done'),
        SessionEnd: hook('stopped'),
      },
    };
    fs.writeFileSync(this.claudeSettingsPath, JSON.stringify(settings, null, 2));
  }

  private watch(): void {
    try {
      this.watcher = fs.watch(this.statusDir, (_event, filename) => {
        if (filename?.endsWith(JOURNAL)) {
          this.readTouched(filename);
          return;
        }
        if (!filename || !filename.endsWith('.json')) {
          return;
        }
        const taskId = filename.slice(0, -'.json'.length);
        // Coalesce bursts of events for the same file.
        clearTimeout(this.pending.get(taskId));
        this.pending.set(
          taskId,
          setTimeout(() => {
            this.pending.delete(taskId);
            this.read(taskId);
          }, 30),
        );
      });
    } catch (err) {
      console.error('[ai-ide] cannot watch status dir', err);
    }
  }

  /** Reads lines appended since the last read (each line is a JSON array of paths). */
  private readTouched(filename: string): void {
    const full = path.join(this.statusDir, filename);
    let size: number;
    try {
      size = fs.statSync(full).size;
    } catch {
      return;
    }
    let offset = this.touchedOffsets.get(filename) ?? 0;
    if (size < offset) {
      offset = 0; // file was recreated
    }
    if (size === offset) {
      return;
    }
    const fd = fs.openSync(full, 'r');
    let text: string;
    try {
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // Keep a partial last line for the next read.
    const complete = text.lastIndexOf('\n') + 1;
    this.touchedOffsets.set(filename, offset + Buffer.byteLength(text.slice(0, complete)));
    const paths: string[] = [];
    for (const line of text.slice(0, complete).split('\n')) {
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed)) {
          paths.push(...parsed.filter((p): p is string => typeof p === 'string'));
        }
      } catch {
        // empty or corrupt line
      }
    }
    if (paths.length > 0) {
      this.touchedEmitter.fire({ taskId: filename.slice(0, -JOURNAL.length), paths });
    }
  }

  /** Emits everything not read yet, i.e. on startup all paths agents have touched so far. */
  readAllTouched(): void {
    for (const name of fs.readdirSync(this.statusDir)) {
      if (name.endsWith(JOURNAL)) {
        this.readTouched(name);
      }
    }
  }

  private read(taskId: string): void {
    let record: StatusRecord;
    try {
      record = JSON.parse(fs.readFileSync(this.statusFileFor(taskId), 'utf8'));
    } catch {
      return;
    }
    if ((this.lastTs.get(taskId) ?? 0) >= record.ts) {
      return;
    }
    this.lastTs.set(taskId, record.ts);
    this.emitter.fire({ taskId, record });
  }

  dispose(): void {
    this.watcher?.close();
    for (const t of this.pending.values()) {
      clearTimeout(t);
    }
    this.emitter.dispose();
    this.touchedEmitter.dispose();
  }
}
