import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateProjectResponse,
  HOME_RUNNER_ID,
  Session,
  type SessionOptions,
  type UserInput,
} from "@codeden/contracts";
import { FakeProvider, type ProviderAdapter } from "@codeden/providers";
import { type RunningRunner, startRunner } from "@codeden/runner";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageLedger } from "../src/db/schema-usage";
import { ingestRunnerEvent } from "../src/events/ingest";
import { McpTokenStore } from "../src/mcp/tokens";
import { type RunnerClient, RunnerCommandError } from "../src/runner/client";
import { type RunningServer, startServer } from "../src/server";
import type { NoticeDraft } from "../src/services/orchestration/notices";
import { TOKEN, waitUntil } from "./support/harness";
import { removeTree } from "./support/remove-tree";

interface Probe {
  options: SessionOptions[];
  inputs: UserInput[];
  beforeOpen?: () => Promise<void>;
  rejectNextSend?: boolean;
}

function adapter(id: string, probe: Probe, readOnly = true): ProviderAdapter {
  const fake = new FakeProvider({ reply: () => "Decision: keep the current plan" });
  return {
    id,
    displayName: id === "codex" ? "Codex" : id === "claude" ? "Claude Code" : id,
    capabilities: () => ({ ...fake.capabilities(), readOnly, mcp: true, reasoningEffort: true }),
    models: () => [
      { id: `${id}-1`, label: `${id} 1`, efforts: ["low", "high"], isDefault: true },
      { id: `${id}-2`, label: `${id} 2`, efforts: ["high"] },
    ],
    detect: async () => ({ ...(await fake.detect()), providerId: id }),
    async openSession(options) {
      probe.options.push(options);
      await probe.beforeOpen?.();
      const runtime = await fake.openSession({
        ...options,
        resumeToken: options.resumeToken ?? `${id}-${randomUUID()}`,
      });
      return new Proxy(runtime, {
        get(target, key) {
          if (key === "send")
            return async (input: UserInput) => {
              probe.inputs.push(input);
              if (probe.rejectNextSend) {
                probe.rejectNextSend = false;
                throw new Error("Target refused to start its first turn");
              }
              // The Fake fixture understands control commands in the live message.
              const text = input.text.replace(
                /^[\s\S]*?End of previous conversation context\. The current input follows\.\n\n/,
                "",
              );
              return target.send({ ...input, text });
            };
          if (key === "events")
            return {
              async *[Symbol.asyncIterator]() {
                for await (const event of target.events) {
                  if (event.type === "session.updated" && event.model === "fake-1") {
                    yield { ...event, model: options.model ?? `${id}-1` };
                  } else if (event.type === "turn.failed" && event.error.kind === "usage_limit") {
                    yield {
                      ...event,
                      error: {
                        ...event.error,
                        message: "Claude Code five-hour usage limit",
                        retryAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
                      },
                    };
                  } else {
                    yield event;
                  }
                }
              },
            };
          const member = Reflect.get(target, key);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    },
  };
}

describe("switching a project manager's provider", () => {
  let home: string;
  let projectPath: string;
  let runner: RunningRunner;
  let client: RunnerClient;
  let server: RunningServer;
  let claude: Probe;
  let codex: Probe;
  let projectId: string;

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.url}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };

  const start = async () => {
    runner = await startRunner({
      home,
      adapters: [
        adapter("claude", claude),
        adapter("codex", codex),
        adapter("no-read-only", { inputs: [], options: [] }, false),
      ],
    });
  };
  const repo = () => server.services.sessionRepo;
  const pm = async () => {
    const session = await server.services.orchestration.roles.ensure("pm", projectId);
    return waitUntil(() =>
      repo().get(session.id).status === "idle" ? repo().get(session.id) : undefined,
    );
  };
  const choice = { provider: "codex", model: "codex-2", effort: "high" } as const;
  const change = (
    id: string,
    target: { provider: string; model: string | null; effort: string | null } = choice,
  ) => api("POST", `/sessions/${id}/switch-provider`, target);
  const send = (id: string, input: UserInput) =>
    api("POST", `/sessions/${id}/messages`, { input, whenBusy: "queue" });
  const settled = (id: string) =>
    waitUntil(() => (repo().get(id).status === "idle" ? true : undefined));
  const notice = (id: string): NoticeDraft => ({
    id,
    type: "session.finished",
    target: "pm",
    projectId,
    sessionId: "agent",
    title: id,
    data: {
      sessionId: "agent",
      purpose: "Review",
      workKey: "request:review",
      startedBy: { kind: "user" },
      outcome: "success",
      summary: "Review the pending work",
    },
  });

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "cd-pm-switch-"));
    projectPath = join(home, "plain-folder");
    mkdirSync(projectPath);
    claude = { inputs: [], options: [] };
    codex = { inputs: [], options: [] };
    await start();
    server = await startServer({
      port: 0,
      dataDir: home,
      token: TOKEN,
      runner: false,
      secrets: "memory",
      checkSetupOnStart: false,
      github: { sync: false },
      orchestration: { wake: { debounceMs: 10, maxWaitMs: 100 } },
    });
    client = server.runners.add({
      id: HOME_RUNNER_ID,
      backend: "local",
      home: true,
      dir: home,
      lockFile: runner.lockFile,
      launch: null,
    });
    await client.start();
    await waitUntil(() => client.mcpProxyUrl ?? undefined);
    const res = await api("POST", "/projects", { source: { type: "local", path: projectPath } });
    projectId = CreateProjectResponse.parse(res.body).project.id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.close();
    await runner?.close();
    await removeTree(home);
  });

  it("keeps the failed Claude conversation, attributes both turns, and starts fresh when switching back", async () => {
    const session = await pm();
    await send(session.id, {
      text: "Decide how to finish issue eleven [fail:usage]",
      attachments: [],
    });
    await waitUntil(() => (repo().get(session.id).status === "failed" ? true : undefined));
    const failed = repo().get(session.id);
    const oldTurn = repo().rootTurnIds(failed).at(-1) as string;
    expect(repo().turn(failed.id, oldTurn)?.error?.message).toBe(
      "Claude Code five-hour usage limit",
    );
    const response = await change(session.id);
    expect(response.status).toBe(200);
    const next = Session.parse(response.body);
    expect(next).toMatchObject({
      id: failed.id,
      rootThreadId: failed.rootThreadId,
      cwd: failed.cwd,
      ...choice,
    });
    expect(next.resumeToken).not.toBe(failed.resumeToken);
    const opened = codex.options[0];
    expect(opened).toMatchObject({ role: "pm", readOnly: true, cwd: failed.cwd, effort: "high" });
    expect(opened?.resumeToken).toBeUndefined();
    expect(opened?.systemPrompt).toMatch(/project manager/i);
    const header = (options: SessionOptions | undefined) => {
      const config = options?.mcpServers.find((value) => value.transport === "http");
      return config?.transport === "http" ? config.headers?.Authorization?.slice(7) : undefined;
    };
    const tokens = new McpTokenStore(server.database.db);
    expect(tokens.verify(header(claude.options[0]))).toBeUndefined();
    expect(tokens.verify(header(opened))).toMatchObject({
      projectId,
      sessionId: next.id,
      role: "pm",
    });
    expect(codex.inputs).toEqual([]);

    const attachment = { type: "file", path: join(projectPath, "context.md") } as const;
    await send(next.id, { text: "Continue with this file", attachments: [attachment] });
    await settled(next.id);
    expect(codex.inputs[0]).toMatchObject({ attachments: [attachment] });
    expect(codex.inputs[0]?.text).toContain("> Decide how to finish issue eleven");
    expect(codex.inputs[0]?.text).toContain("> Claude Code five-hour usage limit");
    expect(repo().find(next.id)?.startMeta?.turnFromUser).toBe(true);
    expect(claude.inputs).toHaveLength(1);

    const latest = repo().get(next.id);
    const newTurn = repo().rootTurnIds(latest).at(-1) as string;
    expect(repo().turn(latest.id, oldTurn)).toMatchObject({
      provider: "claude",
      model: "claude-1",
    });
    expect(repo().turn(latest.id, newTurn)).toMatchObject({ provider: "codex", model: "codex-2" });
    expect(
      repo()
        .rootItems(latest, ["notice"])
        .filter((item) => item.kind === "notice" && item.code === "pm_provider_switched"),
    ).toHaveLength(1);

    expect((await api("PATCH", `/sessions/${latest.id}`, { model: "codex-1" })).status).toBe(200);
    await send(latest.id, { text: "Next request", attachments: [] });
    await settled(latest.id);
    expect(codex.inputs[1]?.text).not.toContain("previous conversation");
    const runtimeId = repo().find(latest.id)?.startMeta?.pmRuntimeId;
    const ts = new Date().toISOString();
    ingestRunnerEvent(server.database.db, server.store, "late-events", {
      type: "event",
      seq: 1,
      ts,
      event: {
        kind: "agent",
        sessionId: latest.id,
        event: { type: "session.updated", resumeToken: "retired", model: "old" },
      },
    });
    ingestRunnerEvent(server.database.db, server.store, "late-events", {
      type: "event",
      seq: 2,
      ts,
      event: {
        kind: "agent",
        sessionId: latest.id,
        runtimeId,
        event: {
          type: "usage.updated",
          threadId: latest.rootThreadId as string,
          turnId: newTurn,
          usage: { inputTokens: 10, outputTokens: 12 },
        },
      },
    });
    expect(repo().get(latest.id).resumeToken).not.toBe("retired");
    const row = server.database.db
      .select()
      .from(usageLedger)
      .where(and(eq(usageLedger.sessionId, latest.id), eq(usageLedger.turnId, newTurn)))
      .get();
    expect(row).toMatchObject({ provider: "codex", model: "codex-2", inputTokens: 10 });
    expect(
      (await change(latest.id, { provider: "claude", model: null, effort: null })).status,
    ).toBe(200);
    expect(claude.options[1]?.resumeToken).toBeUndefined();
    expect(repo().get(latest.id).resumeToken).not.toBe(failed.resumeToken);
  });

  it("serializes queued work and wake notices, with a rejected open, rejected first send and lost reply", async () => {
    const session = await pm();
    let releaseOpen = () => {};
    const held = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    codex.beforeOpen = async () => {
      await held;
      throw new Error("Target failed to open");
    };
    const switching = change(session.id);
    await waitUntil(() => (codex.options.length ? true : undefined));
    try {
      expect(
        await server.services.sessions.send(
          session.id,
          {
            input: { text: "Untrusted queued work", attachments: [], from: "orchestrator" },
            whenBusy: "queue",
          },
          "orchestrator",
        ),
      ).toEqual({ status: "queued" });
      server.services.orchestration.notify(notice("notice-racing-switch"));
      expect((await api("PATCH", `/sessions/${session.id}`, { model: "claude-2" })).status).toBe(
        409,
      );
    } finally {
      releaseOpen();
    }
    expect(await switching).toMatchObject({ status: 502 });
    expect(claude.inputs).toEqual([]);
    expect(server.services.queue.list(session.id)).toHaveLength(1);
    expect(repo().find(session.id)?.startMeta?.pmSwitch?.context).toContain(
      "previous conversation",
    );

    codex.beforeOpen = undefined;
    codex.rejectNextSend = true;
    const request = client.request.bind(client);
    let lost = false;
    let lostDelivery = false;
    vi.spyOn(client, "request").mockImplementation(async (command, timeout) => {
      const result = await request(command, timeout);
      if (command.name === "session.replacePm" && !lost) {
        lost = true;
        throw new RunnerCommandError("timeout", "Switch reply lost");
      }
      if (command.name === "session.send" && command.runtimeId && !lostDelivery) {
        lostDelivery = true;
        throw new RunnerCommandError("timeout", "Delivery reply lost");
      }
      return result;
    });
    expect((await change(session.id)).status).toBe(200);
    await waitUntil(() => (repo().get(session.id).status === "failed" ? true : undefined));
    expect(server.services.queue.list(session.id)).toHaveLength(1);
    expect(repo().find(session.id)?.startMeta?.pmPriorContext).toContain("previous conversation");

    server.services.sessions.releaseOutboxes();
    await server.services.sessions.flushOutbox(session.id);
    await settled(session.id);
    expect(server.services.queue.list(session.id)).toEqual([]);
    expect(codex.inputs).toHaveLength(2);
    expect(codex.inputs[1]).toMatchObject({ from: "orchestrator" });
    expect(codex.inputs[1]?.text).toMatch(/notice-racing-switch/);
    expect(repo().find(session.id)?.startMeta?.turnFromUser).toBe(false);
    expect(repo().find(session.id)?.startMeta?.pmPriorContext).toBeUndefined();
    const history = repo().rootItems(repo().get(session.id), ["user_message", "notice"]);
    expect(
      history.filter(
        (item) => item.kind === "user_message" && item.input.text.includes("Untrusted queued work"),
      ),
    ).toHaveLength(1);
    expect(
      history.filter((item) => item.kind === "notice" && item.code === "orchestration_notices"),
    ).toHaveLength(1);
    expect(codex.options).toHaveLength(2);
    expect(lostDelivery).toBe(true);
    await server.services.sessions.send(
      session.id,
      {
        whenBusy: "queue",
        input: {
          text: "The user's relayed request",
          from: "orchestrator",
          relayedForUser: true,
          attachments: [],
        },
      },
      "orchestrator",
    );
    await settled(session.id);
    expect(repo().find(session.id)?.startMeta?.turnFromUser).toBe(true);
  });

  it("recovers persisted switch intent after a runner restart and lets the next notice carry it", async () => {
    const session = await pm();
    const request = client.request.bind(client);
    const spy = vi.spyOn(client, "request").mockImplementation(async (command, timeout) => {
      if (command.name === "session.replacePm")
        throw new RunnerCommandError("runner_unavailable", "Runner went away");
      return request(command, timeout);
    });
    expect((await change(session.id)).status).toBe(503);
    expect(repo().find(session.id)?.startMeta?.pmSwitch?.refused).not.toBe(true);
    spy.mockRestore();
    await runner.close();
    await start();
    await waitUntil(() => (repo().get(session.id).provider === "codex" ? true : undefined));
    server.services.orchestration.notify(notice("notice-after-restart"));
    await waitUntil(() => (codex.inputs.length ? true : undefined));
    await settled(session.id);
    expect(codex.inputs[0]?.text).toContain("previous conversation");
    expect(codex.inputs[0]?.text).toContain("notice-after-restart");
    expect(repo().find(session.id)?.startMeta?.turnFromUser).toBe(false);
    expect(repo().find(session.id)?.startMeta?.pmPriorContext).toBeUndefined();
  });

  it("rejects ineligible providers, models, efforts, a running PM and a PM waiting for input", async () => {
    const manager = await pm();
    expect(
      (await change(manager.id, { provider: "unavailable", model: null, effort: null })).status,
    ).toBe(400);
    expect(
      (await change(manager.id, { provider: "no-read-only", model: null, effort: null })).status,
    ).toBe(400);
    expect((await change(manager.id, { ...choice, model: "unknown" })).status).toBe(400);
    expect((await change(manager.id, { ...choice, effort: "low" })).status).toBe(400);
    const orchestrator = await server.services.orchestration.roles.ensure("orchestrator", null);
    expect((await change(orchestrator.id)).status).toBe(400);
    const request = client.request.bind(client);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    vi.spyOn(client, "request").mockImplementation(async (command, timeout) => {
      if (command.name === "session.send") {
        started = true;
        await gate;
      }
      return request(command, timeout);
    });
    const sending = send(manager.id, { text: "[approval]", attachments: [] });
    await waitUntil(() => (started ? true : undefined));
    try {
      expect((await change(manager.id)).status).toBe(409);
    } finally {
      release();
    }
    await sending;
    await waitUntil(() => (repo().get(manager.id).status === "waiting" ? true : undefined));
    expect((await change(manager.id)).status).toBe(409);
    expect(codex.options).toEqual([]);
  });
});
