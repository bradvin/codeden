import type { BridgeCaller } from "./bridge-policy";

/**
 * The CodeDen windows by the id of their `webContents`, so the main process knows which server a
 * bridge call came from. A sender that isn't here (a native browser view, anything else) has no
 * bridge at all.
 */
export class WindowRegistry<W> {
  private readonly byContents = new Map<number, { caller: () => BridgeCaller; window: W }>();

  add(contentsId: number, caller: () => BridgeCaller, window: W): void {
    this.byContents.set(contentsId, { caller, window });
  }

  remove(contentsId: number): void {
    this.byContents.delete(contentsId);
  }

  caller(contentsId: number): BridgeCaller | null {
    return this.byContents.get(contentsId)?.caller() ?? null;
  }

  /** The window whose `webContents` has this id. */
  window(contentsId: number): W | undefined {
    return this.byContents.get(contentsId)?.window;
  }

  /** The window showing a server (This Mac is `local`), if there is one. */
  windowFor(serverId: string): W | undefined {
    for (const entry of this.byContents.values()) {
      if (entry.caller().server.id === serverId) return entry.window;
    }
    return undefined;
  }
}
