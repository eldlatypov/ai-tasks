import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * One Markdown file per task with links to what the task produced: Jira issues, merge requests,
 * Confluence pages, the feature stand. The agent keeps it up to date (see hooks/hook.js), the
 * Tasks view shows it under the task.
 */
export class ArtifactsStore implements vscode.Disposable {
  readonly dir: string;
  private readonly emitter = new vscode.EventEmitter<string>();
  /** Fires with the task id whose file changed. */
  readonly onDidChange = this.emitter.event;
  private watcher: fs.FSWatcher | undefined;
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(context: vscode.ExtensionContext) {
    this.dir = path.join(context.globalStorageUri.fsPath, 'artifacts');
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      this.watcher = fs.watch(this.dir, (_event, filename) => {
        if (!filename?.endsWith('.md')) {
          return;
        }
        const taskId = filename.slice(0, -'.md'.length);
        clearTimeout(this.pending.get(taskId));
        this.pending.set(
          taskId,
          setTimeout(() => {
            this.pending.delete(taskId);
            this.emitter.fire(taskId);
          }, 100),
        );
      });
    } catch (err) {
      console.error('[ai-ide] cannot watch artifacts dir', err);
    }
  }

  fileFor(taskId: string): string {
    return path.join(this.dir, `${taskId}.md`);
  }

  /** The task's file, created from the template on first use. */
  ensure(taskId: string, taskName: string): string {
    const file = this.fileFor(taskId);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, template(taskName));
    }
    return file;
  }

  /** Number of links in the task's file, 0 when there is none. */
  linkCount(taskId: string): number {
    try {
      return fs.readFileSync(this.fileFor(taskId), 'utf8').match(/https?:\/\/[^\s)>\]]+/g)?.length ?? 0;
    } catch {
      return 0;
    }
  }

  dispose(): void {
    this.watcher?.close();
    for (const t of this.pending.values()) {
      clearTimeout(t);
    }
    this.emitter.dispose();
  }
}

function template(taskName: string): string {
  return `# ${taskName}

## Jira

## Merge requests

## Confluence

## Stand
`;
}
