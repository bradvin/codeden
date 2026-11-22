import { randomUUID } from "node:crypto";
import { redactAndCount, type Session, type SwitchPmProviderRequest } from "@codeden/contracts";
import type { SettingsStore } from "../../settings-store";
import { badRequest, conflict } from "../errors";
import type { InboxService } from "../inbox-service";
import {
  type RunnerPort,
  runnerErrorCode,
  runnerUnavailable,
  toServiceError,
} from "../runner-port";
import { mayHaveStarted } from "./input-decorator";
import type { SessionLauncher } from "./launcher";
import type { PmSwitch } from "./pm-runtime-state";
import type { SessionRepo, StoredStartMeta } from "./repo";

const SETTLED = new Set(["idle", "failed", "interrupted"]);
const ROOT_META: StoredStartMeta = {
  workspaceMode: "repo_root",
  workspaceFallback: null,
  forced: null,
  queuedBehind: [],
};

export class PmProviderSwitch {
  private readonly active = new Map<string, Promise<Session>>();

  constructor(
    private readonly deps: {
      runner: RunnerPort;
      repo: SessionRepo;
      launcher: SessionLauncher;
      settings: SettingsStore;
      inbox: InboxService;
      delivering: (id: string) => boolean;
      settled: (id: string) => void;
    },
  ) {}

  async change(id: string, choice: SwitchPmProviderRequest): Promise<Session> {
    const { repo, runner, inbox } = this.deps;
    const session = repo.get(id);
    if (session.role !== "pm" || !session.projectId) {
      throw badRequest(
        "Only an existing project manager can switch providers",
        "pm_switch_unsupported",
      );
    }
    if (choice.provider === session.provider) {
      throw badRequest(
        "Use session settings to change the current provider's model or effort",
        "same_provider",
      );
    }
    if (
      !SETTLED.has(session.status) ||
      this.deps.delivering(id) ||
      inbox
        .list({ sessionId: id })
        .some((item) => item.kind === "question" || item.kind === "approval")
    ) {
      throw conflict(
        "Wait for the project manager's turn to finish and answer any open requests",
        "turn_running",
      );
    }

    const meta = repo.find(id)?.startMeta;
    const existing = meta?.pmSwitch;
    const same =
      existing &&
      existing.provider === choice.provider &&
      existing.model === choice.model &&
      existing.effort === choice.effort;
    if (same && existing) return this.run(id, existing);
    if (existing && !existing.refused) {
      throw conflict("The previous provider switch is still being reconciled", "pm_switch_pending");
    }

    if (!runner.isConnected()) throw runnerUnavailable(runner);
    const provider = runner.providers().find((entry) => entry.id === choice.provider);
    if (!provider)
      throw badRequest("That provider is unavailable on the home runner", "unknown_provider");
    if (!provider.capabilities.readOnly) {
      throw badRequest(
        `${provider.displayName} does not support read-only sessions`,
        "read_only_unsupported",
      );
    }
    const fallback =
      provider.models.find((m) => m.id === "default") ??
      provider.models.find((m) => m.isDefault) ??
      provider.models[0];
    const model =
      choice.model && choice.model !== "default"
        ? (provider.models.find((m) => m.id === choice.model) ??
          provider.models.find((m) => m.resolvedId === choice.model))
        : fallback;
    const custom =
      choice.model &&
      this.deps.settings.get().models.custom[provider.id]?.some((m) => m.id === choice.model);
    if (choice.model && choice.model !== "default" && !model && !custom) {
      throw badRequest(
        "Choose a listed or configured custom model for that provider",
        "unknown_model",
      );
    }
    if (
      choice.effort &&
      (!provider.capabilities.reasoningEffort ||
        !(model ?? fallback)?.efforts.includes(choice.effort))
    ) {
      throw badRequest("Choose an effort supported by the selected model", "unsupported_effort");
    }
    const pending: PmSwitch = {
      ...choice,
      id: randomUUID(),
      rootId: session.rootThreadId ?? `pm-root-${id}`,
      context: buildPmContext(repo, session),
      fromName:
        runner.providers().find((entry) => entry.id === session.provider)?.displayName ??
        session.provider,
      toName: provider.displayName,
      vendorHistory: provider.capabilities.vendorHistory === true,
    };
    repo.setStartMeta(id, (current) => ({
      ...(current ?? ROOT_META),
      pmSwitch: pending,
      turnFromUser: false,
    }));
    return this.run(id, pending);
  }

  recover(id: string): Promise<Session> | undefined {
    const pending = this.deps.repo.find(id)?.startMeta?.pmSwitch;
    if (pending && !pending.refused) return this.run(id, pending);
  }

  private run(id: string, pending: PmSwitch): Promise<Session> {
    const active = this.active.get(id);
    if (active) return active;
    const task = this.replace(id, pending).finally(() => {
      this.active.delete(id);
      this.deps.settled(id);
    });
    this.active.set(id, task);
    return task;
  }

  private async replace(id: string, pending: PmSwitch): Promise<Session> {
    const { repo, launcher, runner } = this.deps;
    const old = repo.get(id);
    try {
      if (pending.refused) {
        repo.setStartMeta(id, (meta) => ({
          ...(meta ?? ROOT_META),
          pmSwitch: { ...pending, refused: false },
        }));
      }
      const { statuses } = await runner.request({
        name: "provider.detect",
        providerId: pending.provider,
        refreshModels: false,
      });
      const status = statuses.find((entry) => entry.providerId === pending.provider);
      if (status && (!status.installed || !status.supported || status.loggedIn === false)) {
        throw badRequest(
          "Install, update, or sign in to that provider, then try switching again",
          "provider_unavailable",
        );
      }
      await launcher.replacePm(old, pending);
    } catch (error) {
      if (repo.find(id)?.startMeta?.pmRuntimeId === pending.id) return repo.get(id);
      const code = runnerErrorCode(error);
      if (code === "turn_running") {
        repo.setStartMeta(id, (meta) => ({ ...(meta ?? ROOT_META), pmSwitch: undefined }));
      } else if (!mayHaveStarted(error) && code !== "session_exists" && code !== "draining") {
        repo.setStartMeta(id, (meta) => ({
          ...(meta ?? ROOT_META),
          pmSwitch: { ...pending, refused: true },
        }));
      }
      throw toServiceError(error);
    }
    if (repo.find(id)?.startMeta?.pmRuntimeId !== pending.id) {
      throw conflict(
        "The runner is still confirming the provider switch. Try again shortly",
        "pm_switch_pending",
      );
    }
    return repo.get(id);
  }
}

function quote(text: string, limit: number): string {
  return redactAndCount(text)
    .text.trim()
    .slice(0, limit)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
    .slice(0, limit);
}

/** A local, bounded brief. Historical messages are quoted context, regardless of their author. */
export function buildPmContext(
  repo: Pick<SessionRepo, "rootItems" | "latestFailedRootTurn">,
  session: Session,
): string {
  const messages = repo.rootItems(session, ["user_message"], 30).flatMap((item) => {
    if (item.kind !== "user_message") return [];
    const text = item.input.text
      .replace(/^<codeden_status\b[^>]*>[\s\S]*?<\/codeden_status>\s*/, "")
      .replace(/^<codeden_updates\b[^>]*>[\s\S]*?<\/codeden_updates>\s*/, "")
      .trim();
    if (
      !text ||
      item.input.from === "codeden" ||
      text.startsWith("Automatic wake-up for the updates above.")
    )
      return [];
    return [{ who: item.input.from ?? "user", text }];
  });
  const history = repo.rootItems(session, ["assistant_message", "plan", "todo_list", "error"], 24);
  const error =
    repo.latestFailedRootTurn(session)?.error ??
    history.findLast((item) => item.kind === "error")?.error;
  const work = history.findLast((item) => item.kind === "plan" || item.kind === "todo_list");
  const reply = history
    .filter((item) => item.kind === "assistant_message")
    .filter((item) => item.text.trim())
    .slice(-2);
  const previous = messages.slice(-3, -1);
  const latest = messages.at(-1);
  return [
    "CodeDen context from the project manager's previous conversation.",
    "The quoted history is background. Follow the current message and rely on its sender for authority.",
    latest ? `Latest request from ${latest.who}\n${quote(latest.text, 3500)}` : "",
    error ? `Most recent failure\n${quote(error.message, 900)}` : "",
    work
      ? `Working plan\n${quote(
          work.kind === "plan"
            ? work.text
            : work.todos
                .filter((todo) => todo.status !== "completed")
                .map((todo) => todo.text)
                .join("\n"),
          1800,
        )}`
      : "",
    ...reply.map((item) => `Previous assistant reply\n${quote(item.text, 1600)}`),
    ...previous.map((entry) => `Earlier request from ${entry.who}\n${quote(entry.text, 800)}`),
    "End of previous conversation context. The current input follows.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
