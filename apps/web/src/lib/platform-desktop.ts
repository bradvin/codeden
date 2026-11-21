import type { CodedenDesktopApi } from "@codeden/contracts";
import type { PlatformBridge } from "./platform";

/** Click handlers kept for notifications still on screen (oldest dropped first). */
const MAX_PENDING_CLICKS = 50;

/**
 * A window on another machine's CodeDen (`api.remote`) behaves as a normal browser where the
 * desktop's own machine would leak in: no native folder picker (it would give the server a path
 * on this computer, so the built-in picker browses the server's disk), no native session
 * browser (the runner's Chromium is used) and no desktop settings (they belong to This Mac).
 * Notifications, the badge and links still go through the app.
 *
 * The desktop app's PlatformBridge (§13, §17), built on `window.codedenDesktop`: native
 * notifications (no permission prompt), the app icon badge, the native folder picker, links
 * in the system browser and `codeden://` navigation. Clipboard and focus use the web APIs,
 * which work the same inside the app window.
 */
export function createDesktopPlatform(api: CodedenDesktopApi, web: PlatformBridge): PlatformBridge {
  const clicks = new Map<string, () => void>();
  let counter = 0;
  api.onNotificationClick((tag) => {
    const handler = clicks.get(tag);
    clicks.delete(tag);
    handler?.();
  });
  let loginSupport: Promise<boolean> | undefined;
  // A native view swallows keys; CodeDen's own shortcuts come back here and are replayed on
  // the window, where the shortcut handlers listen.
  api.browser?.onShortcut((s) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { ...s, bubbles: true, cancelable: true }));
  });

  return {
    capabilities: {
      notifications: true,
      badge: true,
      clipboardImages: web.capabilities.clipboardImages,
      folderPicker: !api.remote,
      osIntegration: !api.remote,
      nativeBrowser: Boolean(api.browser),
    },
    nativeBrowser: api.browser ?? null,
    serverSwitcher: api.showServerMenu
      ? {
          current: () =>
            api.info().then(
              (info) => info.server ?? null,
              () => null,
            ),
          showMenu: () => api.showServerMenu?.(),
        }
      : null,
    notificationPermission: () => "granted",
    requestNotificationPermission: async () => "granted",
    notify(title, opts) {
      const tag = opts?.tag ?? `n${++counter}`;
      if (opts?.onClick) {
        clicks.delete(tag);
        clicks.set(tag, opts.onClick);
        while (clicks.size > MAX_PENDING_CLICKS) {
          const oldest = clicks.keys().next().value;
          if (oldest === undefined) break;
          clicks.delete(oldest);
        }
      }
      api.notify({ title, body: opts?.body, tag });
    },
    openExternal: (url) => api.openExternal(url),
    setBadge(count) {
      api.setBadge(count);
    },
    writeClipboard: (text) => web.writeClipboard(text),
    readClipboardImage: () => web.readClipboardImage(),
    isFocused: () => web.isFocused(),
    pickFolder: async (opts) => (api.remote ? null : api.pickFolder(opts)),
    onNavigate: (listener) => api.onNavigate(listener),
    launchAtLoginSupported() {
      if (api.remote) return Promise.resolve(false);
      loginSupport ??= api.info().then(
        (info) => info.launchAtLoginSupported,
        () => false,
      );
      return loginSupport;
    },
  };
}
