import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  parseRemoteServerUrl,
  REMOTE_SERVERS_MAX,
  type RemoteServer,
  RemoteServerName,
  RemoteServersFile,
} from "@codeden/contracts";

/** Why a change to the list was refused, in words the manager window shows. */
export type StoreResult<T> = { ok: true; value: T } | { ok: false; problem: string };

/**
 * The desktop app's list of other CodeDen servers (§17): `<home>/desktop/servers.json`. It belongs
 * to the app, never to a server's settings. "This Mac" is implicit and is not stored. A hand-edited
 * file keeps its valid entries (see `RemoteServersFile`); every change is written at once.
 */
export class ServerStore {
  private servers: RemoteServer[];

  constructor(
    private readonly file: string,
    private readonly newId: () => string = () => randomBytes(8).toString("hex"),
  ) {
    this.servers = readList(file);
  }

  list(): readonly RemoteServer[] {
    return this.servers;
  }

  get(id: string): RemoteServer | undefined {
    return this.servers.find((s) => s.id === id);
  }

  /** The normalized name and address, or why they are refused (nothing is saved). */
  validate(name: string, url: string): StoreResult<{ name: string; url: string }> {
    const parsedName = RemoteServerName.safeParse(name);
    if (!parsedName.success) return { ok: false, problem: "Use a name of 1 to 60 characters." };
    const parsedUrl = parseRemoteServerUrl(url);
    if (!parsedUrl.ok) return { ok: false, problem: parsedUrl.problem };
    const repeat = this.servers.find((s) => s.url === parsedUrl.origin);
    if (repeat)
      return { ok: false, problem: `That address is already in the list as ${repeat.name}.` };
    return { ok: true, value: { name: parsedName.data, url: parsedUrl.origin } };
  }

  add(name: string, url: string): StoreResult<RemoteServer> {
    const checked = this.validate(name, url);
    if (!checked.ok) return checked;
    if (this.servers.length >= REMOTE_SERVERS_MAX) {
      return { ok: false, problem: `At most ${REMOTE_SERVERS_MAX} servers.` };
    }
    const server = { id: this.newId(), ...checked.value };
    this.servers = [...this.servers, server];
    this.save();
    return { ok: true, value: server };
  }

  rename(id: string, name: string): StoreResult<RemoteServer> {
    const current = this.get(id);
    if (!current) return { ok: false, problem: "That server is no longer in the list." };
    const parsed = RemoteServerName.safeParse(name);
    if (!parsed.success) return { ok: false, problem: "Use a name of 1 to 60 characters." };
    const renamed = { ...current, name: parsed.data };
    this.servers = this.servers.map((s) => (s.id === id ? renamed : s));
    this.save();
    return { ok: true, value: renamed };
  }

  remove(id: string): RemoteServer | undefined {
    const gone = this.get(id);
    if (!gone) return undefined;
    this.servers = this.servers.filter((s) => s.id !== id);
    this.save();
    return gone;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ servers: this.servers }, null, 2)}\n`);
    renameSync(temp, this.file);
  }
}

function readList(file: string): RemoteServer[] {
  try {
    return RemoteServersFile.parse(JSON.parse(readFileSync(file, "utf8"))).servers;
  } catch {
    return [];
  }
}
