import type { MenuItemConstructorOptions } from "electron";

/** A server in the menus: This Mac first, then the others in list order. */
export interface ServerEntry {
  id: string;
  name: string;
}

export interface ServerMenuActions {
  open: (id: string) => void;
  add: () => void;
  manage: () => void;
}

/** Most servers that get a Cmd/Ctrl+digit shortcut. */
const SHORTCUTS = 9;

/**
 * The server entries: each server (Cmd/Ctrl+1 to 9 in the application menu), then Add server and
 * Manage servers. `current` marks the window's own server in the popup the header chip opens.
 */
export function serverMenuItems(
  servers: readonly ServerEntry[],
  actions: ServerMenuActions,
  opts: { current?: string; shortcuts?: boolean } = {},
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = servers.map((server, i) => ({
    label: server.name,
    ...(opts.current === undefined
      ? {}
      : { type: "checkbox" as const, checked: server.id === opts.current }),
    ...(opts.shortcuts && i < SHORTCUTS ? { accelerator: `CommandOrControl+${i + 1}` } : {}),
    click: () => actions.open(server.id),
  }));
  items.push({ type: "separator" });
  items.push({ label: "Add Server...", click: actions.add });
  items.push({ label: "Manage Servers...", click: actions.manage });
  return items;
}
