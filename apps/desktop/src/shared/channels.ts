/** IPC channels between the preload bridge and the main process. */
export const CHANNELS = {
  info: "codeden:info",
  pickFolder: "codeden:pick-folder",
  notify: "codeden:notify",
  notificationClick: "codeden:notification-click",
  openExternal: "codeden:open-external",
  setBadge: "codeden:set-badge",
  navigate: "codeden:navigate",
  serverMenu: "codeden:server-menu",
  browserShow: "codeden:browser-show",
  browserHide: "codeden:browser-hide",
  browserCapture: "codeden:browser-capture",
  browserInspect: "codeden:browser-inspect",
  browserShortcut: "codeden:browser-shortcut",
} as const;

/** IPC channels of the app's own "Manage servers" window (not reachable from a server's page). */
export const SERVER_CHANNELS = {
  list: "codeden-servers:list",
  add: "codeden-servers:add",
  rename: "codeden-servers:rename",
  remove: "codeden-servers:remove",
  open: "codeden-servers:open",
  changed: "codeden-servers:changed",
} as const;
