import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from './log';

const API = 'https://open-vsx.org/api';
const LAST_CHECK_KEY = 'aiTasks.lastUpdateCheck';
const DAY = 24 * 60 * 60 * 1000;

interface Release {
  version: string;
  download: string;
  sha256?: string;
}

/**
 * Updates from Open VSX for VS Code itself. Cursor, Windsurf, VSCodium and other editors install
 * from Open VSX and update the extension on their own; Microsoft's VS Code only updates
 * extensions from its own marketplace, so an install from a .vsix would stay on its version.
 */
export class Updater implements vscode.Disposable {
  private readonly timers: NodeJS.Timeout[] = [];
  private busy = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    if (!this.applies()) {
      return;
    }
    // Not at startup: the window has more important things to do then.
    this.timers.push(setTimeout(() => void this.check(false), 30_000));
    // Windows stay open for days; look again now and then, still at most once a day.
    this.timers.push(setInterval(() => void this.check(false), 6 * 60 * 60 * 1000));
  }

  /** Only VS Code proper, an installed (not developed) extension, and not switched off. */
  private applies(): boolean {
    return (
      ['vscode', 'vscode-insiders'].includes(vscode.env.uriScheme) &&
      this.context.extensionMode === vscode.ExtensionMode.Production &&
      vscode.workspace.getConfiguration('aiTasks').get<boolean>('checkForUpdates', true)
    );
  }

  /** @param manual from the command: no daily limit, and say so when there is nothing new */
  async check(manual: boolean): Promise<void> {
    if (this.busy || (!manual && !this.applies())) {
      return;
    }
    const last = this.context.globalState.get<number>(LAST_CHECK_KEY, 0);
    if (!manual && Date.now() - last < DAY) {
      return;
    }
    this.busy = true;
    try {
      await this.context.globalState.update(LAST_CHECK_KEY, Date.now());
      const current = String(this.context.extension.packageJSON.version);
      const release = await this.latest();
      if (!release || compareVersions(release.version, current) <= 0) {
        if (manual) {
          void vscode.window.showInformationMessage(`AI Tasks ${current} is the latest version.`);
        }
        return;
      }
      const install = 'Install';
      const notes = "What's New";
      const choice = await vscode.window.showInformationMessage(
        `AI Tasks ${release.version} is available (you have ${current}).`,
        install,
        notes,
        'Later',
      );
      if (choice === notes) {
        void vscode.env.openExternal(vscode.Uri.parse(this.pageUrl()));
      } else if (choice === install) {
        await this.install(release);
      }
    } catch (err) {
      log.warn('update check failed', err);
      if (manual) {
        void vscode.window.showWarningMessage(`AI Tasks: could not check for updates: ${String(err)}`);
      }
    } finally {
      this.busy = false;
    }
  }

  private async latest(): Promise<Release | undefined> {
    const [namespace, name] = this.context.extension.id.split('.');
    const meta = (await (await get(`${API}/${namespace}/${name}`)).json()) as {
      version?: string;
      files?: { download?: string; sha256?: string };
    };
    if (!meta.version || !meta.files?.download) {
      return undefined;
    }
    return { version: meta.version, download: meta.files.download, sha256: meta.files.sha256 };
  }

  private async install(release: Release): Promise<void> {
    const file = path.join(os.tmpdir(), `${this.context.extension.id}-${release.version}.vsix`);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Installing AI Tasks ${release.version}…` },
      async () => {
        const data = Buffer.from(await (await get(release.download)).arrayBuffer());
        if (release.sha256) {
          const expected = (await (await get(release.sha256)).text()).trim().split(/\s+/)[0].toLowerCase();
          const actual = crypto.createHash('sha256').update(data).digest('hex');
          if (expected !== actual) {
            throw new Error(`the downloaded package does not match its checksum (${actual} ≠ ${expected})`);
          }
        }
        fs.writeFileSync(file, data);
        try {
          await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
        } finally {
          fs.rmSync(file, { force: true });
        }
      },
    );
    const reload = 'Reload Window';
    const choice = await vscode.window.showInformationMessage(
      `AI Tasks ${release.version} is installed. Reload the window to use it; running agents are resumed after the reload.`,
      reload,
    );
    if (choice === reload) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  private pageUrl(): string {
    const [namespace, name] = this.context.extension.id.split('.');
    return `https://open-vsx.org/extension/${namespace}/${name}`;
  }

  dispose(): void {
    for (const t of this.timers) {
      clearTimeout(t);
    }
  }
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return res;
}

/** 1.2.10 > 1.2.9; a pre-release suffix (1.3.0-beta) counts as lower than the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) {
      return Math.sign(d);
    }
  }
  if (x.pre === y.pre) {
    return 0;
  }
  return x.pre === undefined ? 1 : y.pre === undefined ? -1 : x.pre < y.pre ? -1 : 1;
}
