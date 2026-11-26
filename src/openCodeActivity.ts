import { setTimeout as delay } from 'node:timers/promises';
import { Service } from '@opencode/client/service';
import type { PendingWork } from './status';

type ServiceEndpoint = NonNullable<Awaited<ReturnType<typeof Service.discover>>>;
type ReportActivity = (state: 'thinking' | 'background', work?: PendingWork[]) => void;

interface BackgroundJob {
  kind: string;
  title?: string;
  description?: string;
  command?: string;
}

export class OpenCodeActivity {
  private controller?: AbortController;
  private endpoint?: ServiceEndpoint;

  constructor(private readonly sessionId: string, private readonly report: ReportActivity) {}

  start(): void {
    if (this.controller) {
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.report('thinking');
    void this.watch(controller.signal);
  }

  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  private async watch(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let work: PendingWork[] = [];
      try {
        this.endpoint ??= await Service.discover();
        if (this.endpoint && !signal.aborted) {
          work = await this.backgroundWork(this.endpoint, signal);
        }
      } catch {
        if (!signal.aborted) {
          this.endpoint = undefined;
        }
      }
      if (!signal.aborted) {
        this.report(work.length > 0 ? 'background' : 'thinking', work);
        await delay(1000, undefined, { signal, ref: false }).catch(() => {});
      }
    }
  }

  private async backgroundWork(endpoint: ServiceEndpoint, signal: AbortSignal): Promise<PendingWork[]> {
    const options = {
      headers: Service.headers(endpoint),
      redirect: 'error' as const,
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    };
    const active = await fetch(new URL('/api/session/active', endpoint.url), options);
    if (!active.ok) {
      throw new Error(`OpenCode active sessions returned ${active.status}`);
    }
    const { data: sessions } = await active.json() as { data: Record<string, { type: string }> };
    if (sessions[this.sessionId]?.type === 'running') {
      return [];
    }

    const url = new URL('/api/experimental/job', endpoint.url);
    url.search = new URLSearchParams({ sessionID: this.sessionId, status: 'running', descendants: 'true' }).toString();
    const jobs = await fetch(url, options);
    if (!jobs.ok) {
      throw new Error(`OpenCode background jobs returned ${jobs.status}`);
    }
    const { data } = await jobs.json() as { data: BackgroundJob[] };
    return data.map(job => ({
      kind: job.kind === 'subagent' ? 'agent' : job.kind,
      label: job.title || job.description || job.command || job.kind,
    }));
  }
}
