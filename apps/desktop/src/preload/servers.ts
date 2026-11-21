/**
 * Preload for the app's own "Manage servers" window (a static page shipped with the app): the
 * list of servers, add, rename and remove. Never loaded into a window that shows a server's UI.
 */
import type { CodedenServersApi } from "@codeden/contracts";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import { SERVER_CHANNELS } from "../shared/channels";

const api: CodedenServersApi = {
  list: () => ipcRenderer.invoke(SERVER_CHANNELS.list),
  add: (name, url) => ipcRenderer.invoke(SERVER_CHANNELS.add, { name, url }),
  rename: (id, name) => ipcRenderer.invoke(SERVER_CHANNELS.rename, { id, name }),
  remove: (id) => ipcRenderer.invoke(SERVER_CHANNELS.remove, id),
  open: (id) => ipcRenderer.send(SERVER_CHANNELS.open, id),
  onChange: (listener) => {
    const handler = (_event: IpcRendererEvent, rows: Parameters<typeof listener>[0]) =>
      listener(rows);
    ipcRenderer.on(SERVER_CHANNELS.changed, handler);
    return () => {
      ipcRenderer.off(SERVER_CHANNELS.changed, handler);
    };
  },
};

contextBridge.exposeInMainWorld("codedenServers", api);
