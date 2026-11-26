import { createHash } from 'crypto';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import * as vscode from 'vscode';
import { OpenCodeActivity } from './openCodeActivity';
import { childEnv, IPty, loadNodePty } from './pty';
import type { AgentState, PendingWork } from './status';

export type TerminalKind = 'agent' | 'shell';

export interface BackgroundTerminalOptions {
  id: string;
  name: string;
  kind: TerminalKind;
  cwd: string;
  shell: string;
  shellArgs: string[];
  env: Record<string, string>;
  onDidChangeCodexStatus?: () => void;
  openCodeStatus?: {
    sessionId: string;
    sharedService: boolean;
    onState: (state: AgentState, work?: PendingWork[]) => void;
  };
  /** Typed into the shell right after it starts. */
  initialCommand?: string;
}

type ViewState = 'hidden' | 'attaching' | 'shown';

/**
 * A terminal whose process outlives its tab.
 *
 * VS Code cannot hide a terminal without killing it, so the process lives here (node-pty) and
 * a headless xterm keeps the screen contents. Showing the terminal creates an extension
 * terminal (Pseudoterminal) and replays the serialized screen into it; hiding just disposes
 * that view while the agent keeps working in the background.
 */
export class BackgroundTerminal implements vscode.Disposable {
  readonly id: string;
  readonly kind: TerminalKind;
  name: string;
  codexNeedsInput?: boolean;

  private readonly pty: IPty;
  private readonly screen: HeadlessTerminal;
  private readonly openCodeActivity?: OpenCodeActivity;
  private readonly serializer = new SerializeAddon();
  private mouseReportEncoding: 1006 | 1016 | undefined;
  private cols = 120;
  private rows = 30;

  private view: vscode.Terminal | undefined;
  private viewWrite: vscode.EventEmitter<string> | undefined;
  private viewClose: vscode.EventEmitter<number | void> | undefined;
  private viewState: ViewState = 'hidden';
  private pendingOutput: string[] = [];
  private input: Promise<void> = Promise.resolve();

  private exitCode: number | undefined;
  private readonly exitEmitter = new vscode.EventEmitter<number>();
  /** Fires once when the process exits. */
  readonly onExit = this.exitEmitter.event;
  private readonly inputEmitter = new vscode.EventEmitter<void>();
  /** Fires when the user types into the terminal. */
  readonly onInput = this.inputEmitter.event;
  private readonly viewEmitter = new vscode.EventEmitter<void>();
  /** Fires when the terminal is shown or hidden. */
  readonly onDidChangeView = this.viewEmitter.event;

  constructor(options: BackgroundTerminalOptions) {
    this.id = options.id;
    this.kind = options.kind;
    this.name = options.name;

    this.screen = new HeadlessTerminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: 5000,
      allowProposedApi: true,
    });
    this.screen.loadAddon(this.serializer);
    this.screen.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      for (const mode of params) {
        if (mode === 1006 || mode === 1016) {
          this.mouseReportEncoding = mode;
        }
      }
      return false;
    });
    this.screen.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (params.includes(1006) || params.includes(1016)) {
        this.mouseReportEncoding = undefined;
      }
      return false;
    });
    this.screen.parser.registerEscHandler({ final: 'c' }, () => {
      this.mouseReportEncoding = undefined;
      return false;
    });
    const onDidChangeCodexStatus = options.onDidChangeCodexStatus;
    if (onDidChangeCodexStatus) {
      this.screen.parser.registerOscHandler(7501, (data) => {
        const state = /^state=(idle|working|blocked|done|error):app=codex(?::|$)/.exec(data)?.[1];
        if (!state && (data !== 'state=clear' || this.codexNeedsInput === undefined)) {
          return false;
        }
        const needsInput = state === 'blocked';
        if (this.codexNeedsInput !== needsInput) {
          this.codexNeedsInput = needsInput;
          onDidChangeCodexStatus();
        }
        return true;
      });
    }
    const openCodeStatus = options.openCodeStatus;
    if (openCodeStatus) {
      const sessionId = openCodeStatus.sessionId;
      if (openCodeStatus.sharedService) {
        this.openCodeActivity = new OpenCodeActivity(sessionId, openCodeStatus.onState);
      }
      const report = (state: AgentState) => {
        if (state === 'thinking' && this.openCodeActivity) {
          this.openCodeActivity.start();
          return;
        }
        this.openCodeActivity?.stop();
        openCodeStatus.onState(state);
      };
      // OpenCode hashes session IDs longer than the OSC 7501 ID limit.
      const id = sessionId.length <= 32 ? sessionId : `ses_${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}`;
      let reporting = false;
      this.screen.parser.registerOscHandler(7501, (data) => {
        if (data === '?') {
          reporting = true;
          this.pty.write('\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\');
          return true;
        }
        if (data === 'state=clear' && reporting) {
          reporting = false;
          report('stopped');
          return true;
        }

        const [status, ...fields] = data.split(':');
        if (!fields.includes(`id=${id}`) || (status !== 'state=clear' && !fields.includes('app=opencode'))) {
          return false;
        }
        switch (status) {
          case 'state=working':
            report('thinking');
            return true;
          case 'state=blocked':
            report('waiting');
            return true;
          case 'state=idle':
            report('idle');
            return true;
          case 'state=done':
          case 'state=error':
          case 'state=clear':
            report('done');
            return true;
          default:
            return false;
        }
      });
    }

    this.pty = loadNodePty().spawn(options.shell, options.shellArgs, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: options.cwd,
      env: childEnv(options.env),
    });
    this.pty.onData((data) => this.onPtyData(data));
    this.pty.onExit(({ exitCode }) => {
      this.openCodeActivity?.stop();
      this.exitCode = exitCode;
      this.viewClose?.fire(exitCode);
      this.exitEmitter.fire(exitCode);
    });

    if (options.initialCommand) {
      this.pty.write(options.initialCommand + '\r');
    }
  }

  get isShown(): boolean {
    return this.view !== undefined;
  }

  get hasExited(): boolean {
    return this.exitCode !== undefined;
  }

  /** The VS Code terminal currently displaying this process, if shown. */
  get terminal(): vscode.Terminal | undefined {
    return this.view;
  }

  /** Shows the terminal as an editor tab in the given column (or reveals it if already shown). */
  show(viewColumn: vscode.ViewColumn, preserveFocus: boolean, iconPath?: vscode.ThemeIcon): vscode.Terminal | undefined {
    if (this.hasExited) {
      return undefined;
    }
    if (this.view) {
      this.view.show(preserveFocus);
      return this.view;
    }

    const write = new vscode.EventEmitter<string>();
    const close = new vscode.EventEmitter<number | void>();
    const pseudo: vscode.Pseudoterminal = {
      onDidWrite: write.event,
      onDidClose: close.event,
      open: (dims) => this.attach(write, dims),
      close: () => this.detach(),
      handleInput: (data) => {
        // Keystrokes go through a chain so a paste waiting for the clipboard is not overtaken.
        this.input = this.input.then(() => this.forwardInput(data));
        // Focus in/out reports (DECSET 1004, which Claude Code enables) are not the user typing.
        if (data !== '\x1b[I' && data !== '\x1b[O') {
          this.inputEmitter.fire();
        }
      },
      setDimensions: (dims) => this.resize(dims.columns, dims.rows),
    };

    this.viewWrite = write;
    this.viewClose = close;
    this.view = vscode.window.createTerminal({
      name: this.name,
      pty: pseudo,
      iconPath: iconPath ?? new vscode.ThemeIcon(this.kind === 'agent' ? 'hubot' : 'terminal'),
      location: { viewColumn, preserveFocus },
      isTransient: true,
    });
    this.viewEmitter.fire();
    return this.view;
  }

  /** Closes the tab, keeps the process running. */
  hide(): void {
    if (!this.view) {
      return;
    }
    const view = this.view;
    this.detach();
    view.dispose();
  }

  write(data: string): void {
    this.pty.write(data);
  }

  kill(): void {
    this.hide();
    if (!this.hasExited) {
      try {
        this.pty.kill();
      } catch {
        // already gone
      }
    }
  }

  /**
   * VS Code can't see which program runs in an extension terminal, so its terminalShellType
   * context key keeps the value of the last regular terminal. When that was PowerShell, the
   * built-in pastePwsh binding takes Ctrl+V and sends a raw ^V (meant for PSReadLine) instead
   * of the clipboard text. On Windows Ctrl+V in a terminal is paste, so a lone ^V can only come
   * from there: paste the clipboard the way the terminal would have.
   */
  private async forwardInput(data: string): Promise<void> {
    if (data === '\x16' && process.platform === 'win32') {
      const text = await vscode.env.clipboard.readText().then(undefined, () => '');
      if (text) {
        this.pty.write(pasteSequence(text, this.screen.modes.bracketedPasteMode));
        return;
      }
    }
    this.pty.write(data);
  }

  private onPtyData(data: string): void {
    this.screen.write(data);
    if (this.viewState === 'shown') {
      this.viewWrite?.fire(data);
    } else if (this.viewState === 'attaching') {
      this.pendingOutput.push(data);
    }
  }

  private attach(write: vscode.EventEmitter<string>, dims: vscode.TerminalDimensions | undefined): void {
    if (write !== this.viewWrite) {
      return; // a stale view
    }
    this.viewState = 'attaching';
    this.pendingOutput = [];
    // xterm parses writes asynchronously: wait until everything received so far is on the
    // headless screen, snapshot it, then stream whatever arrived in the meantime.
    this.screen.write('', () => {
      if (write !== this.viewWrite) {
        return;
      }
      let snapshot = this.serializer.serialize({ scrollback: 2000 });
      if (this.mouseReportEncoding) {
        snapshot += `\x1b[?${this.mouseReportEncoding}h`;
      }
      write.fire(snapshot);
      for (const chunk of this.pendingOutput) {
        write.fire(chunk);
      }
      this.pendingOutput = [];
      this.viewState = 'shown';
      if (dims) {
        this.resize(dims.columns, dims.rows);
      }
    });
  }

  private detach(): void {
    if (!this.view) {
      return;
    }
    this.view = undefined;
    this.viewWrite?.dispose();
    this.viewClose?.dispose();
    this.viewWrite = undefined;
    this.viewClose = undefined;
    this.viewState = 'hidden';
    this.pendingOutput = [];
    // Whether we hid it or the user closed the tab, the process keeps running.
    this.viewEmitter.fire();
  }

  private resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0 || (cols === this.cols && rows === this.rows)) {
      return;
    }
    this.cols = cols;
    this.rows = rows;
    this.screen.resize(cols, rows);
    if (!this.hasExited) {
      try {
        this.pty.resize(cols, rows);
      } catch {
        // process may be exiting
      }
    }
  }

  dispose(): void {
    this.openCodeActivity?.stop();
    this.kill();
    this.screen.dispose();
    this.exitEmitter.dispose();
    this.inputEmitter.dispose();
    this.viewEmitter.dispose();
  }
}

/** What xterm sends for a paste: CR line endings, wrapped in markers if the app asked for bracketed paste. */
export function pasteSequence(text: string, bracketed: boolean): string {
  const body = text.replace(/\r?\n/g, '\r');
  // Pasted text must not be able to end the paste early.
  return bracketed ? `\x1b[200~${body.replace(/\x1b\[20[01]~/g, '')}\x1b[201~` : body;
}
