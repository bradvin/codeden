import {
  type DesktopInfo,
  DesktopNotification,
  Id,
  type NativeBrowserBounds,
  NativeBrowserShow,
} from "@codeden/contracts";
import {
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Notification,
  shell,
} from "electron";
import { z } from "zod";
import { CHANNELS } from "../shared/channels";
import { createNotifier, type Notifier } from "./notifications";
import { externalUrl, redactToken } from "./security";
import {
  authorizeBridgeCall,
  type BridgeCall,
  type BridgeCaller,
  notificationTitle,
} from "./servers/bridge-policy";

export interface BridgeHost {
  /** Which server's window a `webContents` is, null for anything that isn't one. */
  caller: (contentsId: number) => BridgeCaller | null;
  info: (caller: BridgeCaller) => DesktopInfo;
  /** Bring a server's window up and tell it the notification with `tag` was clicked. */
  notificationClicked: (serverId: string, tag: string | undefined) => void;
  setBadge: (caller: BridgeCaller, count: number) => void;
  /** Pop up the native servers menu over the calling window. */
  showServerMenu: (window: BrowserWindow | null, caller: BridgeCaller) => void;
  icon: string;
  log: (message: string) => void;
  /** Native browser views (§17 Phase 2); This Mac's window only. */
  browser: {
    show(sessionId: string, bounds: NativeBrowserBounds): void;
    hide(sessionId: string): void;
    capture(sessionId: string): Promise<string | null>;
    inspect(sessionId: string): void;
  };
}

const PickFolder = z
  .object({ title: z.string().max(200).optional(), defaultPath: z.string().max(4096).optional() })
  .default({});

/**
 * The main-process side of `window.codedenDesktop` (§17). Every call passes
 * `authorizeBridgeCall`: it must come from a CodeDen window's own server origin, and a window on
 * another machine's server only gets the smaller set of calls. Every payload is validated.
 */
export function registerBridge(host: BridgeHost): void {
  /** The caller, when `call` is allowed from this sender; null (and a log line) otherwise. */
  const allow = (
    event: IpcMainEvent | IpcMainInvokeEvent,
    call: BridgeCall,
  ): BridgeCaller | null => {
    const caller = host.caller(event.sender.id);
    const url = event.senderFrame?.url ?? "";
    if (authorizeBridgeCall(caller, call, url)) return caller;
    host.log(
      `bridge: refused ${call} from ${caller?.server.name ?? "an unknown window"}, frame ${redactToken(url).slice(0, 200) || "an unknown frame"}`,
    );
    return null;
  };

  ipcMain.handle(CHANNELS.info, (event) => {
    const caller = allow(event, "info");
    return caller ? host.info(caller) : null;
  });

  ipcMain.handle(CHANNELS.pickFolder, async (event, raw) => {
    if (!allow(event, "pickFolder")) return null;
    const opts = PickFolder.parse(raw ?? {});
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: opts.title ?? "Choose a folder",
      defaultPath: opts.defaultPath,
      properties: ["openDirectory", "createDirectory"] as Array<
        "openDirectory" | "createDirectory"
      >,
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // A notification with the tag of one still on screen replaces it (a grouped burst stays one).
  // One notifier per server, so a click goes back to the window that showed it.
  const notifiers = new Map<string, Notifier>();
  const notifierFor = (serverId: string): Notifier => {
    let notifier = notifiers.get(serverId);
    if (!notifier) {
      notifier = createNotifier(
        (opts) =>
          new Notification({
            ...opts,
            icon: process.platform === "darwin" ? undefined : host.icon,
          }),
        (tag) => host.notificationClicked(serverId, tag),
      );
      notifiers.set(serverId, notifier);
    }
    return notifier;
  };
  ipcMain.on(CHANNELS.notify, (event, raw) => {
    const caller = allow(event, "notify");
    if (!caller || !Notification.isSupported()) return;
    const parsed = DesktopNotification.safeParse(raw);
    if (!parsed.success) return;
    notifierFor(caller.server.id).show({
      title: notificationTitle(caller, parsed.data.title),
      body: parsed.data.body ?? "",
      tag: parsed.data.tag || undefined,
    });
  });

  ipcMain.on(CHANNELS.openExternal, (event, raw) => {
    if (!allow(event, "openExternal") || typeof raw !== "string") return;
    const url = externalUrl(raw);
    if (url) void shell.openExternal(url);
  });

  ipcMain.on(CHANNELS.setBadge, (event, raw) => {
    const caller = allow(event, "setBadge");
    if (!caller) return;
    const count = z.int().min(0).max(100_000).safeParse(raw);
    if (count.success) host.setBadge(caller, count.data);
  });

  ipcMain.on(CHANNELS.serverMenu, (event) => {
    const caller = allow(event, "serverMenu");
    if (caller) host.showServerMenu(BrowserWindow.fromWebContents(event.sender), caller);
  });

  // Native browser views: the UI only places them; tabs and navigation go through the server.
  ipcMain.on(CHANNELS.browserShow, (event, raw) => {
    if (!allow(event, "browser")) return;
    const show = NativeBrowserShow.safeParse(raw);
    if (show.success) host.browser.show(show.data.sessionId, show.data.bounds);
  });
  ipcMain.on(CHANNELS.browserHide, (event, raw) => {
    if (!allow(event, "browser")) return;
    const sessionId = Id.safeParse(raw);
    if (sessionId.success) host.browser.hide(sessionId.data);
  });
  ipcMain.handle(CHANNELS.browserCapture, (event, raw) => {
    if (!allow(event, "browser")) return null;
    const sessionId = Id.safeParse(raw);
    return sessionId.success ? host.browser.capture(sessionId.data) : null;
  });
  ipcMain.on(CHANNELS.browserInspect, (event, raw) => {
    if (!allow(event, "browser")) return;
    const sessionId = Id.safeParse(raw);
    if (sessionId.success) host.browser.inspect(sessionId.data);
  });
}
