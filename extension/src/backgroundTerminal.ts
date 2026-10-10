import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import * as vscode from 'vscode';
import { childEnv, IPty, loadNodePty } from './pty';

export type TerminalKind = 'agent' | 'shell';

export interface BackgroundTerminalOptions {
  id: string;
  name: string;
  kind: TerminalKind;
  cwd: string;
  shell: string;
  shellArgs: string[];
  env: Record<string, string>;
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

  private readonly pty: IPty;
  private readonly screen: HeadlessTerminal;
  private readonly serializer = new SerializeAddon();
  private cols = 120;
  private rows = 30;

  private view: vscode.Terminal | undefined;
  private viewWrite: vscode.EventEmitter<string> | undefined;
  private viewClose: vscode.EventEmitter<number | void> | undefined;
  private viewState: ViewState = 'hidden';
  private pendingOutput: string[] = [];

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

    this.pty = loadNodePty().spawn(options.shell, options.shellArgs, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: options.cwd,
      env: childEnv(options.env),
    });
    this.pty.onData((data) => this.onPtyData(data));
    this.pty.onExit(({ exitCode }) => {
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
        this.pty.write(data);
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
      write.fire(this.serializer.serialize({ scrollback: 2000 }));
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
    this.kill();
    this.screen.dispose();
    this.exitEmitter.dispose();
    this.inputEmitter.dispose();
    this.viewEmitter.dispose();
  }
}
