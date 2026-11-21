import { ActivitySummary, type RemoteServerState } from "@codeden/contracts";

/** What the last background check of a remote server found. */
export interface RemoteStatus {
  state: RemoteServerState;
  /** The last counts it answered with (kept while it is unreachable, dropped when signed out). */
  activity: ActivitySummary | null;
}

export interface RemoteMonitorOptions {
  origin: string;
  /** Sends requests through the server's own session partition, so its device cookie is used. */
  fetch: typeof fetch;
  intervalMs?: number;
  /** Slower polling while the server doesn't answer. */
  retryMs?: number;
  onChange: (status: RemoteStatus) => void;
}

const SIGNED_OUT = new Set([401, 403]);

/**
 * Polls one remote server's `GET /api/activity` (§17) through that server's own session, so the
 * device sign-in the window made is what authenticates it. The install token of This Mac never
 * reaches this class. A server that is down, signed out or older than `/api/activity` is a state
 * for the tray to show, never an error.
 */
export class RemoteMonitor {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  status: RemoteStatus = { state: "connecting", activity: null };

  constructor(private readonly opts: RemoteMonitorOptions) {}

  start(): void {
    this.stopped = false;
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Poll now and schedule the next one. */
  async poll(): Promise<RemoteStatus> {
    clearTimeout(this.timer);
    const next = await this.check();
    const changed = JSON.stringify(next) !== JSON.stringify(this.status);
    this.status = next;
    if (changed) this.opts.onChange(next);
    if (!this.stopped) {
      const wait =
        next.state === "ok" ? (this.opts.intervalMs ?? 5_000) : (this.opts.retryMs ?? 20_000);
      this.timer = setTimeout(() => void this.poll(), wait);
      this.timer.unref();
    }
    return next;
  }

  private async check(): Promise<RemoteStatus> {
    try {
      const res = await this.opts.fetch(`${this.opts.origin}/api/activity`, {
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (SIGNED_OUT.has(res.status)) return { state: "signed-out", activity: null };
      if (!res.ok) return { state: "unreachable", activity: this.status.activity };
      const activity = ActivitySummary.safeParse(await res.json());
      return activity.success
        ? { state: "ok", activity: activity.data }
        : { state: "unreachable", activity: this.status.activity };
    } catch {
      return { state: "unreachable", activity: this.status.activity };
    }
  }
}
