import type { ActivitySummary, DesktopUpdateState } from "@codeden/contracts";
import { remoteLine, type ServerSummary, totalBadge } from "./servers/summary";

export interface TrayInput {
  /** Latest counts from the server, null before the first answer. */
  activity: ActivitySummary | null;
  /** The server answered the last poll. */
  connected: boolean;
  update: DesktopUpdateState;
  /** `settings.updates.mode` is `auto` (a download installs on quit, no prompt needed). */
  autoUpdate: boolean;
  /** Other servers the app shows (§17), in list order. */
  remotes?: readonly ServerSummary[];
  /** This Mac's own summary, for the badge total (the lines above stay about This Mac). */
  local?: ServerSummary;
}

export interface TrayView {
  tooltip: string;
  /** Status lines shown (disabled) at the top of the tray menu. */
  lines: string[];
  /** One entry per other server: its status line, and Open in a submenu. */
  servers: Array<{ id: string; line: string }>;
  /** Count for the app icon badge: things waiting on the user, across every server. */
  badge: number;
  /** An update action for the tray menu, if one is due. */
  update: { label: string; command: "download" | "install" | null } | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What the tray shows (§17): running and waiting agents and the inbox, from the server's
 * activity counts (never per provider), plus the update step when one is due.
 */
export function trayView(input: TrayInput): TrayView {
  const { activity, update } = input;
  const lines: string[] = [];
  if (!input.connected || !activity) {
    lines.push(input.connected ? "Starting..." : "Not connected to the CodeDen server");
  } else {
    lines.push(
      activity.running > 0
        ? `${plural(activity.running, "agent", "agents")} running`
        : "No agents running",
    );
    if (activity.waiting > 0) lines.push(`${activity.waiting} waiting on you`);
    if (activity.inbox > 0) lines.push(`${plural(activity.inbox, "item", "items")} in the inbox`);
  }
  const summary =
    input.connected && activity
      ? [
          activity.running > 0 ? `${activity.running} running` : null,
          activity.waiting > 0 ? `${activity.waiting} waiting` : null,
        ]
          .filter(Boolean)
          .join(", ") || "idle"
      : "not connected";
  const remotes = input.remotes ?? [];
  const local: ServerSummary = input.local ?? {
    id: "local",
    name: "This Mac",
    state: null,
    connected: input.connected,
    activity,
  };
  const servers = remotes.map((r) => ({ id: r.id, line: remoteLine(r) }));
  return {
    tooltip: [`CodeDen (${summary})`, ...servers.map((s) => s.line)].join("\n"),
    lines,
    servers,
    badge: totalBadge([local, ...remotes]),
    update: updateItem(update, input.autoUpdate),
  };
}

function updateItem(update: DesktopUpdateState, auto: boolean): TrayView["update"] {
  if (update.unsupported || !update.latest) return null;
  switch (update.phase) {
    case "available":
      return auto ? null : { label: `Download CodeDen ${update.latest}`, command: "download" };
    case "downloading":
      return {
        label: `Downloading CodeDen ${update.latest}${update.percent === null ? "" : ` (${Math.floor(update.percent)}%)`}`,
        command: null,
      };
    case "downloaded":
      return { label: `Restart to update to ${update.latest}`, command: "install" };
    case "installing":
      return { label: `Updating to ${update.latest}...`, command: null };
    default:
      return null;
  }
}
