import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopUpdateState } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeBridgeCall,
  type BridgeCaller,
  notificationTitle,
} from "../src/main/servers/bridge-policy";
import { checkServer } from "../src/main/servers/check";
import { serverMenuItems } from "../src/main/servers/menu";
import { clearRemoteData, remoteLoadUrl, remotePartition } from "../src/main/servers/partition";
import { WindowRegistry } from "../src/main/servers/registry";
import { RemoteMonitor, type RemoteStatus } from "../src/main/servers/remote-monitor";
import { ServerStore } from "../src/main/servers/store";
import { remoteLine, type ServerSummary, totalBadge } from "../src/main/servers/summary";
import { trayView } from "../src/main/tray-view";

const URL_A = "https://omaweb.tail1234.ts.net:8446";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("server list store", () => {
  let dir: string;
  let file: string;
  let n: number;
  const open = () => new ServerStore(file, () => `id${String(++n).padStart(6, "0")}`);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-servers-"));
    file = join(dir, "desktop", "servers.json");
    n = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds, renames and removes, and keeps the list across a restart", () => {
    const store = open();
    const added = store.add("Omarchy", " HTTPS://Omaweb.Tail1234.ts.net:8446 ");
    expect(added).toEqual({
      ok: true,
      value: { id: "id000001", name: "Omarchy", url: URL_A },
    });
    expect(open().list()).toEqual([{ id: "id000001", name: "Omarchy", url: URL_A }]);

    expect(store.rename("id000001", "Home box")).toMatchObject({ ok: true });
    expect(open().get("id000001")?.name).toBe("Home box");
    expect(store.rename("id000001", "   ").ok).toBe(false);

    expect(store.remove("id000001")?.name).toBe("Home box");
    expect(open().list()).toEqual([]);
    expect(store.remove("id000001")).toBeUndefined();
  });

  it("refuses plain http, paths, credentials, repeats and empty names", () => {
    const store = open();
    for (const url of [
      "http://omaweb.tail1234.ts.net",
      `${URL_A}/projects`,
      "https://me:pw@omaweb.tail1234.ts.net",
      "https://127.0.0.1:4317",
      "omaweb",
    ]) {
      expect(store.add("X", url).ok, url).toBe(false);
    }
    expect(store.add("", URL_A).ok).toBe(false);
    expect(store.add("A", URL_A).ok).toBe(true);
    expect(store.add("B", URL_A.toUpperCase())).toMatchObject({ ok: false });
    expect(store.list()).toHaveLength(1);
  });

  it("starts empty from a missing or broken file and drops only the bad entries", () => {
    expect(open().list()).toEqual([]);
    {
      const store = open();
      store.add("Good", URL_A);
      const text = JSON.parse(readFileSync(file, "utf8"));
      text.servers.push({ id: "bad", name: "Plain", url: "http://x.example.ts.net" });
      writeFileSync(file, JSON.stringify(text));
      expect(
        open()
          .list()
          .map((s) => s.name),
      ).toEqual(["Good"]);
      writeFileSync(file, "{not json");
      expect(open().list()).toEqual([]);
    }
  });
});

describe("checking a server before it is saved", () => {
  it("asks /api/health with no credentials and accepts a CodeDen", async () => {
    const fetch = vi.fn(async () =>
      json({ ok: true, name: "codeden", version: "0.7.7", uptimeSec: 3 }),
    );
    const result = await checkServer(URL_A, { fetch: fetch as never, version: "0.7.7" });
    expect(result).toEqual({ ok: true, version: "0.7.7", warning: null });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${URL_A}/api/health`);
    expect(init.credentials).toBe("omit");
    expect(init.headers).toBeUndefined();
  });

  it("warns, never fails, on a different version", async () => {
    const fetch = async () => json({ ok: true, name: "codeden", version: "0.6.0", uptimeSec: 3 });
    const result = await checkServer(URL_A, { fetch: fetch as never, version: "0.7.7" });
    expect(result).toMatchObject({ ok: true, version: "0.6.0" });
    expect(result.ok && result.warning).toContain("0.6.0");
  });

  it("fails for an unreachable address, an untrusted certificate and a non-CodeDen answer", async () => {
    const down = await checkServer(URL_A, {
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as never,
      version: "1",
    });
    expect(down).toMatchObject({ ok: false });
    const cert = await checkServer(URL_A, {
      fetch: (async () => {
        throw new Error("net::ERR_CERT_AUTHORITY_INVALID");
      }) as never,
      version: "1",
    });
    expect(cert.ok === false && cert.problem).toContain("certificate");
    const refused = await checkServer(URL_A, {
      fetch: (async () => json({}, 403)) as never,
      version: "1",
    });
    expect(refused.ok === false && refused.problem).toContain("403");
    const other = await checkServer(URL_A, {
      fetch: (async () => json({ hello: 1 })) as never,
      version: "1",
    });
    expect(other).toMatchObject({ ok: false });
  });
});

const remote = (name = "Omarchy"): BridgeCaller => ({
  kind: "remote",
  server: { id: "abc123", name, remote: true },
  origin: URL_A,
});
const local: BridgeCaller = {
  kind: "local",
  server: { id: "local", name: "This Mac", remote: false },
  origin: "http://127.0.0.1:4317",
};

describe("bridge permissions by window kind and origin", () => {
  it("lets This Mac's window make every call from its own origin", () => {
    for (const call of [
      "info",
      "pickFolder",
      "notify",
      "openExternal",
      "setBadge",
      "serverMenu",
      "browser",
    ] as const) {
      expect(authorizeBridgeCall(local, call, "http://127.0.0.1:4317/inbox")).toBe(true);
    }
  });

  it("lets a remote window make only the smaller set", () => {
    for (const call of ["info", "notify", "openExternal", "setBadge", "serverMenu"] as const) {
      expect(authorizeBridgeCall(remote(), call, `${URL_A}/sessions/1`), call).toBe(true);
    }
    for (const call of ["pickFolder", "browser"] as const) {
      expect(authorizeBridgeCall(remote(), call, `${URL_A}/`), call).toBe(false);
    }
  });

  it("refuses unknown senders, unloaded windows and frames from another origin", () => {
    expect(authorizeBridgeCall(null, "info", `${URL_A}/`)).toBe(false);
    expect(authorizeBridgeCall({ ...remote(), origin: null }, "info", `${URL_A}/`)).toBe(false);
    expect(authorizeBridgeCall(remote(), "info", "https://evil.example.com/")).toBe(false);
    expect(authorizeBridgeCall(remote(), "info", "https://omaweb.tail1234.ts.net:9999/")).toBe(
      false,
    );
    expect(authorizeBridgeCall(remote(), "info", "http://omaweb.tail1234.ts.net:8446/")).toBe(
      false,
    );
    expect(authorizeBridgeCall(local, "info", URL_A)).toBe(false);
    expect(authorizeBridgeCall(remote(), "info", "")).toBe(false);
  });

  it("names the server in a remote notification only", () => {
    expect(notificationTitle(remote(), "Approval needed")).toBe("Omarchy: Approval needed");
    expect(notificationTitle(local, "Approval needed")).toBe("Approval needed");
  });

  it("finds the caller by webContents and the window by server", () => {
    const registry = new WindowRegistry<string>();
    registry.add(7, () => remote(), "remote window");
    registry.add(1, () => local, "local window");
    expect(registry.caller(7)?.kind).toBe("remote");
    expect(registry.caller(99)).toBeNull();
    expect(registry.windowFor("abc123")).toBe("remote window");
    expect(registry.windowFor("local")).toBe("local window");
    registry.remove(7);
    expect(registry.caller(7)).toBeNull();
    expect(registry.windowFor("abc123")).toBeUndefined();
  });
});

describe("a remote server's session", () => {
  it("has its own persistent partition per server", () => {
    expect(remotePartition("abc123")).toBe("persist:codeden-remote-abc123");
    expect(remotePartition("abc123")).not.toBe(remotePartition("def456"));
  });

  it("loads the server's own address, never with a token, and never another host", () => {
    expect(remoteLoadUrl(URL_A)).toBe(`${URL_A}/`);
    expect(remoteLoadUrl(URL_A, "/sessions/s1")).toBe(`${URL_A}/sessions/s1`);
    expect(remoteLoadUrl(URL_A, "//evil.example.com/x")).toBe(`${URL_A}/`);
    expect(remoteLoadUrl(URL_A, "https://evil.example.com")).toBe(`${URL_A}/`);
    expect(remoteLoadUrl(URL_A)).not.toContain("token");
  });

  it("clears everything it stored when the server is removed", async () => {
    const calls: string[] = [];
    await clearRemoteData({
      clearStorageData: async () => void calls.push("storage"),
      clearCache: async () => void calls.push("cache"),
      clearAuthCache: async () => void calls.push("auth"),
      flushStorageData: () => void calls.push("flush"),
    });
    expect(calls).toEqual(["storage", "cache", "auth", "flush"]);
  });
});

describe("polling a remote's activity", () => {
  const monitor = (fetch: typeof globalThis.fetch) => {
    const changes: RemoteStatus[] = [];
    const m = new RemoteMonitor({ origin: URL_A, fetch, onChange: (s) => changes.push(s) });
    return { m, changes };
  };

  it("uses the fetch it was given (the server's own session) with cookies, and no token", async () => {
    const fetch = vi.fn(async () => json({ running: 2, waiting: 1, inbox: 4 }));
    const { m, changes } = monitor(fetch as never);
    expect(await m.poll()).toEqual({ state: "ok", activity: { running: 2, waiting: 1, inbox: 4 } });
    expect(changes).toHaveLength(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${URL_A}/api/activity`);
    expect(init.credentials).toBe("include");
    expect(init.headers).toBeUndefined();
    await m.poll();
    expect(changes).toHaveLength(1); // unchanged answers are not news
    m.stop();
  });

  it("reports signed out and unreachable as states, never as errors", async () => {
    let answer: () => Promise<Response> = async () => json({ error: {} }, 401);
    const { m } = monitor((async () => answer()) as never);
    expect((await m.poll()).state).toBe("signed-out");
    answer = async () => json({ running: 1, waiting: 0, inbox: 0 });
    expect((await m.poll()).state).toBe("ok");
    answer = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await m.poll()).toEqual({
      state: "unreachable",
      activity: { running: 1, waiting: 0, inbox: 0 },
    });
    answer = async () => json({ nonsense: true });
    expect((await m.poll()).state).toBe("unreachable");
    answer = async () => json({}, 401);
    expect(await m.poll()).toEqual({ state: "signed-out", activity: null });
    m.stop();
  });
});

describe("badge and tray across servers", () => {
  const summary = (over: Partial<ServerSummary>): ServerSummary => ({
    id: "x",
    name: "Omarchy",
    state: "ok",
    connected: true,
    activity: { running: 0, waiting: 0, inbox: 0 },
    ...over,
  });

  it("totals what waits on you across This Mac and every remote that answers", () => {
    const servers = [
      summary({
        id: "local",
        name: "This Mac",
        state: null,
        activity: { running: 1, waiting: 2, inbox: 3 },
      }),
      summary({ activity: { running: 0, waiting: 4, inbox: 1 } }),
      summary({
        id: "y",
        state: "unreachable",
        connected: false,
        activity: { running: 0, waiting: 9, inbox: 9 },
      }),
      summary({ id: "z", state: "signed-out", connected: false, activity: null }),
    ];
    expect(totalBadge(servers)).toBe(3 + 4);
    expect(totalBadge([])).toBe(0);
  });

  it("describes each remote's counts or state", () => {
    expect(remoteLine(summary({ activity: { running: 2, waiting: 1, inbox: 0 } }))).toBe(
      "Omarchy: 2 agents running, 1 waiting",
    );
    expect(remoteLine(summary({}))).toBe("Omarchy: idle");
    expect(remoteLine(summary({ state: "signed-out", connected: false, activity: null }))).toBe(
      "Omarchy: signed out",
    );
    expect(remoteLine(summary({ state: "unreachable", connected: false }))).toBe(
      "Omarchy: unreachable",
    );
    expect(remoteLine(summary({ state: "connecting", connected: false, activity: null }))).toBe(
      "Omarchy: connecting...",
    );
  });

  it("puts every server in the tray and the badge total in the view", () => {
    const update: DesktopUpdateState = {
      phase: "idle",
      current: "1",
      latest: null,
      checkedAt: null,
      percent: null,
      error: null,
      unsupported: null,
    };
    const view = trayView({
      activity: { running: 1, waiting: 1, inbox: 2 },
      connected: true,
      update,
      autoUpdate: false,
      remotes: [
        summary({ id: "a1", activity: { running: 0, waiting: 3, inbox: 0 } }),
        summary({ id: "b2", name: "Down", state: "unreachable", connected: false }),
      ],
    });
    expect(view.badge).toBe(2 + 3);
    expect(view.servers.map((s) => s.id)).toEqual(["a1", "b2"]);
    expect(view.lines).toContain("1 agent running"); // This Mac's lines stay about This Mac
    expect(view.tooltip).toContain("Down: unreachable");
  });
});

describe("the Servers menu", () => {
  const actions = { open: vi.fn(), add: vi.fn(), manage: vi.fn() };
  const entries = Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, name: `Server ${i}` }));

  it("gives the first nine servers Cmd/Ctrl+1 to 9, then Add and Manage", () => {
    const items = serverMenuItems(entries, actions, { shortcuts: true });
    expect(items.slice(0, 11).map((i) => i.accelerator)).toEqual([
      ...Array.from({ length: 9 }, (_, i) => `CommandOrControl+${i + 1}`),
      undefined,
      undefined,
    ]);
    expect(items.slice(-2).map((i) => i.label)).toEqual(["Add Server...", "Manage Servers..."]);
    items[1]?.click?.(undefined as never, undefined, undefined as never);
    expect(actions.open).toHaveBeenCalledWith("s1");
  });

  it("marks the window's own server in the chip popup, with no shortcuts", () => {
    const items = serverMenuItems(entries.slice(0, 2), actions, { current: "s1" });
    expect(items.map((i) => i.checked)).toEqual([false, true, undefined, undefined, undefined]);
    expect(items.some((i) => i.accelerator)).toBe(false);
  });
});

describe("no way around certificate checks, no token to a remote", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });
  const sources = files(join(import.meta.dirname, "../src")).map(
    (f) => [f, readFileSync(f, "utf8")] as const,
  );

  it("never installs a certificate bypass", () => {
    for (const [file, text] of sources) {
      expect(text, file).not.toMatch(
        /certificate-error|ignore-certificate-errors|setCertificateVerifyProc|allowInsecure|rejectUnauthorized/,
      );
    }
  });

  it("keeps the install token out of the remote code", () => {
    for (const [file, text] of sources.filter(([f]) => f.includes("/servers/"))) {
      expect(text, file).not.toMatch(/launchUrl|readToken|\.token\b|authorization/i);
    }
  });
});
