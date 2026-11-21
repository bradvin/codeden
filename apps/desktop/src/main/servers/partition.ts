/** The session partition of a remote server: its own cookies and storage, kept across restarts. */
export function remotePartition(serverId: string): string {
  return `persist:codeden-remote-${serverId}`;
}

/** The part of an Electron session that clearing a server's stored data uses (a fake in tests). */
export interface ClearableSession {
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
  flushStorageData(): void;
}

/** Remove everything a server's window stored: its device sign-in, caches and web storage. */
export async function clearRemoteData(session: ClearableSession): Promise<void> {
  await session.clearStorageData();
  await session.clearCache();
  await session.clearAuthCache();
  session.flushStorageData();
}

/** The URL a remote window loads: the server's own address, never with a token. */
export function remoteLoadUrl(origin: string, path = "/"): string {
  const url = new URL(path.startsWith("/") ? path : "/", origin);
  // A path is only ever a route inside the server (a notification target), never another host.
  return url.origin === origin ? url.href : `${origin}/`;
}
