import type { ActivitySummary, RemoteServerState } from "@codeden/contracts";

/** One server's line in the aggregate: This Mac or a remote. */
export interface ServerSummary {
  id: string;
  name: string;
  /** `null` for This Mac. */
  state: RemoteServerState | null;
  /** The server answered the last poll. */
  connected: boolean;
  activity: ActivitySummary | null;
}

/** What waits on the user on one server (the same figure the app badge always showed). */
export function waitingOn(server: Pick<ServerSummary, "connected" | "activity">): number {
  const a = server.activity;
  return server.connected && a ? Math.max(a.inbox, a.waiting) : 0;
}

/** The app badge: waiting on you across This Mac and every remote that answers. */
export function totalBadge(servers: readonly ServerSummary[]): number {
  return servers.reduce((sum, s) => sum + waitingOn(s), 0);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A remote's line in the tray menu (and the tooltip's detail): its state or its counts. */
export function remoteLine(server: ServerSummary): string {
  if (server.state === "signed-out") return `${server.name}: signed out`;
  if (server.state === "unreachable") return `${server.name}: unreachable`;
  if (server.state === "connecting" || !server.activity) return `${server.name}: connecting...`;
  const { running, waiting } = server.activity;
  const parts = [
    running > 0 ? `${plural(running, "agent", "agents")} running` : "idle",
    waiting > 0 ? `${waiting} waiting` : null,
  ].filter(Boolean);
  return `${server.name}: ${parts.join(", ")}`;
}
