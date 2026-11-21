import { type DesktopServerRef, LOCAL_SERVER_ID, type ServerRow } from "@codeden/contracts";
import { type BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import type { ServerHub } from "./hub";
import { type ServerEntry, serverMenuItems } from "./menu";

export interface SwitcherOptions {
  hub: ServerHub;
  /** "This Mac" (or "This computer" off macOS). */
  localName: string;
  showLocal: () => void;
  /** The "Manage servers" window. */
  manage: () => void;
}

/**
 * Moving between servers (§17): This Mac and every remote as menu entries (the Servers menu and
 * the popup of the header chip), as rows for the manager window, and "open this one".
 */
export class ServerSwitcher {
  constructor(private readonly opts: SwitcherOptions) {}

  get localRef(): DesktopServerRef {
    return { id: LOCAL_SERVER_ID, name: this.opts.localName, remote: false };
  }

  entries(): ServerEntry[] {
    return [
      { id: LOCAL_SERVER_ID, name: this.opts.localName },
      ...this.opts.hub.servers().map((s) => ({ id: s.id, name: s.name })),
    ];
  }

  rows(): ServerRow[] {
    return [
      { id: LOCAL_SERVER_ID, name: this.opts.localName, url: null, state: null },
      ...this.opts.hub.servers().map((s) => ({
        id: s.id,
        name: s.name,
        url: s.url,
        state: this.opts.hub.state(s.id),
      })),
    ];
  }

  open(id: string): void {
    if (id === LOCAL_SERVER_ID) this.opts.showLocal();
    else this.opts.hub.open(id);
  }

  /** The Servers menu of the application menu, with Cmd/Ctrl+1 to 9. */
  menuItems(): MenuItemConstructorOptions[] {
    return serverMenuItems(this.entries(), this.actions(), { shortcuts: true });
  }

  /** The header chip's popup: the same entries, the window's own server marked. */
  popup(window: BrowserWindow | null, current: string): void {
    const menu = Menu.buildFromTemplate(
      serverMenuItems(this.entries(), this.actions(), { current }),
    );
    menu.popup(window ? { window } : undefined);
  }

  private actions() {
    return {
      open: (id: string) => this.open(id),
      add: () => this.opts.manage(),
      manage: () => this.opts.manage(),
    };
  }
}
