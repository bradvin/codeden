import { join } from "node:path";
import type {
  AddServerResult,
  DesktopServerRef,
  RemoteServer,
  RemoteServerState,
} from "@codeden/contracts";
import { dialog, net, type Session, session } from "electron";
import { MainWindow } from "../window";
import type { BridgeCaller } from "./bridge-policy";
import { checkServer } from "./check";
import { clearRemoteData, remoteLoadUrl, remotePartition } from "./partition";
import type { WindowRegistry } from "./registry";
import { RemoteMonitor, type RemoteStatus } from "./remote-monitor";
import type { ServerStore } from "./store";
import type { ServerSummary } from "./summary";

export interface ServerHubOptions {
  store: ServerStore;
  /** `<home>/desktop`: where each server's window state is kept. */
  stateDir: string;
  preload: string;
  icon: string;
  appVersion: string;
  registry: WindowRegistry<MainWindow>;
  /** The list or a server's state changed (menus, tray and badge follow). */
  onChange: () => void;
  log: (message: string) => void;
}

interface Remote {
  server: RemoteServer;
  monitor: RemoteMonitor;
  window: MainWindow | null;
}

/**
 * The other CodeDen servers the app shows (§17): one window and one background monitor per remote
 * server, each in its own persistent session partition. Nothing here knows This Mac's install
 * token: a remote is reached only through its own session, over https, with Chromium's
 * certificate checks and no way around them.
 */
export class ServerHub {
  private readonly remotes = new Map<string, Remote>();
  private quitting = false;

  constructor(private readonly opts: ServerHubOptions) {
    for (const server of opts.store.list()) this.track(server);
  }

  /** Start watching every remote in the list. */
  start(): void {
    for (const remote of this.remotes.values()) remote.monitor.start();
  }

  stop(): void {
    for (const remote of this.remotes.values()) remote.monitor.stop();
  }

  /** Let the next close of every remote window really close (Quit). */
  allowClose(): void {
    this.quitting = true;
    for (const remote of this.remotes.values()) remote.window?.allowClose();
  }

  servers(): readonly RemoteServer[] {
    return this.opts.store.list();
  }

  summaries(): ServerSummary[] {
    return [...this.remotes.values()].map(({ server, monitor }) => ({
      id: server.id,
      name: server.name,
      state: monitor.status.state satisfies RemoteServerState,
      connected: monitor.status.state === "ok",
      activity: monitor.status.activity,
    }));
  }

  state(id: string): RemoteServerState | null {
    return this.remotes.get(id)?.monitor.status.state ?? null;
  }

  /** Open (or focus) a server's window. */
  open(id: string): MainWindow | null {
    const remote = this.remotes.get(id);
    if (!remote || this.quitting) return null;
    if (!remote.window) this.createWindow(remote);
    remote.window?.show();
    return remote.window;
  }

  async add(name: string, url: string): Promise<AddServerResult> {
    // Name and address first, then the server itself; only a CodeDen that answers is saved.
    const valid = this.opts.store.validate(name, url);
    if (!valid.ok) return { ok: false, problem: valid.problem };
    const check = await checkServer(valid.value.url, {
      fetch: net.fetch as typeof fetch,
      version: this.opts.appVersion,
    });
    if (!check.ok) return { ok: false, problem: check.problem };
    const added = this.opts.store.add(valid.value.name, valid.value.url);
    if (!added.ok) return { ok: false, problem: added.problem };
    this.track(added.value).monitor.start();
    this.opts.onChange();
    return { ok: true, server: added.value, warning: check.warning };
  }

  rename(id: string, name: string): { ok: boolean; problem?: string } {
    const renamed = this.opts.store.rename(id, name);
    if (!renamed.ok) return { ok: false, problem: renamed.problem };
    const remote = this.remotes.get(id);
    if (remote) {
      remote.server = renamed.value;
      remote.window?.rename(renamed.value.name);
    }
    this.opts.onChange();
    return { ok: true };
  }

  /** Remove a server: its window closes and its sign-in and stored data are cleared. */
  async remove(id: string): Promise<boolean> {
    const remote = this.remotes.get(id);
    if (!remote) return false;
    remote.monitor.stop();
    this.remotes.delete(id);
    if (remote.window) {
      this.opts.registry.remove(remote.window.webContentsId);
      remote.window.allowClose();
      remote.window.window.destroy();
    }
    this.opts.store.remove(id);
    await clearRemoteData(this.sessionOf(id)).catch((error: unknown) =>
      this.opts.log(`servers: could not clear ${id}: ${String(error)}`),
    );
    this.opts.onChange();
    return true;
  }

  private sessionOf(id: string): Session {
    return session.fromPartition(remotePartition(id));
  }

  private track(server: RemoteServer): Remote {
    const ses = this.sessionOf(server.id);
    const remote: Remote = {
      server,
      window: null,
      monitor: new RemoteMonitor({
        origin: server.url,
        // Through this server's own session, so its device cookie is the credential.
        fetch: ((input, init) => ses.fetch(input as string, init)) as typeof fetch,
        onChange: (status: RemoteStatus) => {
          this.opts.log(`servers: ${remote.server.name} is ${status.state}`);
          this.opts.onChange();
        },
      }),
    };
    this.remotes.set(server.id, remote);
    return remote;
  }

  private createWindow(remote: Remote): void {
    const { server } = remote;
    const win = new MainWindow({
      preload: this.opts.preload,
      icon: this.opts.icon,
      stateFile: join(this.opts.stateDir, `window-state-${server.id}.json`),
      show: true,
      // Closing keeps the window (and its notifications) alive in the tray, as for This Mac.
      hideOnClose: () => true,
      log: this.opts.log,
      remote: { partition: remotePartition(server.id), name: server.name, origin: server.url },
    });
    remote.window = win;
    const ref = (): DesktopServerRef => ({ id: server.id, name: remote.server.name, remote: true });
    const caller = (): BridgeCaller => ({ kind: "remote", server: ref(), origin: server.url });
    this.opts.registry.add(win.webContentsId, caller, win);
    win.window.once("closed", () => {
      this.opts.registry.remove(win.webContentsId);
      if (remote.window === win) remote.window = null;
    });
    void win.load(remoteLoadUrl(server.url)).catch((error: unknown) => {
      this.opts.log(`servers: ${server.name} did not load: ${String(error)}`);
      if (!win.window.isDestroyed()) void this.offerRetry(remote, win);
    });
  }

  private async offerRetry(remote: Remote, win: MainWindow): Promise<void> {
    const { response } = await dialog.showMessageBox(win.window, {
      type: "warning",
      title: "CodeDen",
      message: `Could not open ${remote.server.name}.`,
      detail: "Check that this device is signed in to your tailnet and the server is running.",
      buttons: ["Retry", "Close"],
      defaultId: 0,
    });
    if (response !== 0 || win.window.isDestroyed()) return;
    void win.load(remoteLoadUrl(remote.server.url)).catch(() => void this.offerRetry(remote, win));
  }
}
