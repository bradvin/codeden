import type { DesktopServerRef } from "@codeden/contracts";
import { isServerUrl } from "../security";

/** The bridge calls a page can make (`window.codedenDesktop`); events to the page need no check. */
export type BridgeCall =
  | "info"
  | "pickFolder"
  | "notify"
  | "openExternal"
  | "setBadge"
  | "serverMenu"
  | "browser";

/** Who is calling: the window's server, and the origin that window may call from. */
export interface BridgeCaller {
  kind: "local" | "remote";
  server: DesktopServerRef;
  /** The server origin the window shows, null before it loaded. */
  origin: string | null;
}

/**
 * What a window on another machine's server may call (§17). `pickFolder` would hand the server a
 * path on this computer, and `browser.*` places native views whose relay runs here and could not
 * reach a remote runner; both stay with This Mac's window.
 */
const REMOTE_CALLS: ReadonlySet<BridgeCall> = new Set([
  "info",
  "notify",
  "openExternal",
  "setBadge",
  "serverMenu",
]);

/**
 * The one gate every bridge call passes in the main process: the sender must be a registered
 * CodeDen window, the frame must be on that window's server origin, and a remote window may only
 * make the calls above.
 */
export function authorizeBridgeCall(
  caller: BridgeCaller | null,
  call: BridgeCall,
  frameUrl: string,
): boolean {
  if (!caller || caller.origin === null || !isServerUrl(frameUrl, caller.origin)) return false;
  return caller.kind === "local" || REMOTE_CALLS.has(call);
}

/** A remote server's notifications name it, so two servers' alerts can't be mistaken. */
export function notificationTitle(caller: BridgeCaller, title: string): string {
  return caller.kind === "remote" ? `${caller.server.name}: ${title}` : title;
}
