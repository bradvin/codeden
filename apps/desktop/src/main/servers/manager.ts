import { pathToFileURL } from "node:url";
import type { AddServerResult, ServerRow } from "@codeden/contracts";
import { BrowserWindow, ipcMain, nativeTheme } from "electron";
import { z } from "zod";
import { SERVER_CHANNELS } from "../../shared/channels";

export interface ManagerHost {
  rows: () => ServerRow[];
  add: (name: string, url: string) => Promise<AddServerResult>;
  rename: (id: string, name: string) => { ok: boolean; problem?: string };
  remove: (id: string) => Promise<boolean>;
  open: (id: string) => void;
}

export interface ManagerOptions {
  /** `dist/servers-preload.cjs` */
  preload: string;
  /** `dist/assets/servers.html` */
  page: string;
  icon: string;
  host: ManagerHost;
  log: (message: string) => void;
}

const Add = z.object({ name: z.string().max(200), url: z.string().max(500) });
const Rename = z.object({ id: z.string().max(100), name: z.string().max(200) });
const ServerId = z.string().max(100);

/**
 * "Manage servers": the app's own window for the server list. It loads one static page shipped
 * with the app (no network, no server content) and its bridge answers only that page: a window
 * showing a server's UI never gets this API, and the handlers check the sender.
 */
export class ServerManager {
  private window: BrowserWindow | null = null;
  private readonly pageUrl: string;

  constructor(private readonly opts: ManagerOptions) {
    this.pageUrl = pathToFileURL(opts.page).href;
    this.register();
  }

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 640,
      height: 560,
      minWidth: 480,
      minHeight: 420,
      title: "CodeDen servers",
      icon: this.opts.icon,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0d10" : "#ffffff",
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.opts.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.window = win;
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("will-attach-webview", (event) => event.preventDefault());
    win.on("closed", () => {
      if (this.window === win) this.window = null;
    });
    void win.loadURL(this.pageUrl);
  }

  /** Tell an open manager window the list changed. */
  changed(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(SERVER_CHANNELS.changed, this.opts.host.rows());
    }
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }

  private fromPage(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
    const ok =
      this.window !== null &&
      !this.window.isDestroyed() &&
      event.sender === this.window.webContents &&
      event.senderFrame?.url === this.pageUrl;
    if (!ok) this.opts.log("servers: ignored a call from outside the manager window");
    return ok;
  }

  private register(): void {
    const { host } = this.opts;
    ipcMain.handle(SERVER_CHANNELS.list, (event) => (this.fromPage(event) ? host.rows() : []));
    ipcMain.handle(SERVER_CHANNELS.add, async (event, raw): Promise<AddServerResult> => {
      const input = Add.safeParse(raw);
      if (!this.fromPage(event) || !input.success) return { ok: false, problem: "Not allowed." };
      return host.add(input.data.name, input.data.url);
    });
    ipcMain.handle(SERVER_CHANNELS.rename, (event, raw) => {
      const input = Rename.safeParse(raw);
      if (!this.fromPage(event) || !input.success) return { ok: false, problem: "Not allowed." };
      return host.rename(input.data.id, input.data.name);
    });
    ipcMain.handle(SERVER_CHANNELS.remove, async (event, raw) => {
      const id = ServerId.safeParse(raw);
      if (!this.fromPage(event) || !id.success) return { ok: false };
      return { ok: await host.remove(id.data) };
    });
    ipcMain.on(SERVER_CHANNELS.open, (event, raw) => {
      const id = ServerId.safeParse(raw);
      if (this.fromPage(event) && id.success) host.open(id.data);
    });
  }
}
