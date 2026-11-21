import { describe, expect, it } from "vitest";
import {
  AddServerResult,
  DesktopInfo,
  LOCAL_SERVER_ID,
  parseRemoteServerUrl,
  REMOTE_SERVERS_MAX,
  RemoteServer,
  RemoteServersFile,
} from "../src";

const server = { id: "abc123def", name: "Omarchy", url: "https://omaweb.tail1234.ts.net:8446" };

describe("remote server addresses", () => {
  it("accepts https://host[:port] and normalizes it", () => {
    expect(parseRemoteServerUrl(" HTTPS://Box.Tail1234.ts.net:443 ")).toEqual({
      ok: true,
      origin: "https://box.tail1234.ts.net",
    });
    expect(parseRemoteServerUrl("https://box.tail1234.ts.net:8446")).toEqual({
      ok: true,
      origin: "https://box.tail1234.ts.net:8446",
    });
  });

  it.each([
    "http://box.tail1234.ts.net",
    "https://box.tail1234.ts.net/app",
    "https://box.tail1234.ts.net/?x=1",
    "https://me:pw@box.tail1234.ts.net",
    "https://100.64.0.1",
    "https://localhost:4317",
    "https://box.tail1234.ts.net:0",
    "box.tail1234.ts.net",
  ])("refuses %s", (input) => {
    expect(parseRemoteServerUrl(input).ok).toBe(false);
  });
});

describe("the server list file", () => {
  it("round-trips an entry", () => {
    expect(RemoteServer.parse(JSON.parse(JSON.stringify(server)))).toEqual(server);
  });

  it("never takes the local id", () => {
    expect(RemoteServer.safeParse({ ...server, id: LOCAL_SERVER_ID }).success).toBe(false);
  });

  it("drops bad, repeated and surplus entries instead of the whole list", () => {
    const many = Array.from({ length: REMOTE_SERVERS_MAX + 5 }, (_, i) => ({
      id: `id${String(i).padStart(4, "0")}`,
      name: `S${i}`,
      url: `https://s${i}.example.ts.net`,
    }));
    const parsed = RemoteServersFile.parse({
      servers: [
        server,
        { ...server, id: "other00" }, // same address
        { ...server, id: "bad", url: "http://x.example.ts.net" },
        "junk",
        ...many,
      ],
    });
    expect(parsed.servers).toHaveLength(REMOTE_SERVERS_MAX);
    expect(parsed.servers[0]).toEqual(server);
    expect(RemoteServersFile.parse({}).servers).toEqual([]);
    expect(RemoteServersFile.parse({ servers: 5 }).servers).toEqual([]);
  });
});

describe("desktop info and add results", () => {
  it("carries the server a window shows", () => {
    const info = {
      version: "1.0.0",
      platform: "darwin",
      packaged: true,
      ownsServer: false,
      launchAtLoginSupported: false,
      server: { id: server.id, name: server.name, remote: true },
    } as const;
    expect(DesktopInfo.parse(info)).toEqual(info);
  });

  it("round-trips an add result", () => {
    const ok = { ok: true, server, warning: "Runs CodeDen 0.7.0." } as const;
    expect(AddServerResult.parse(ok)).toEqual(ok);
    const bad = { ok: false, problem: "Could not reach it." } as const;
    expect(AddServerResult.parse(bad)).toEqual(bad);
  });
});
