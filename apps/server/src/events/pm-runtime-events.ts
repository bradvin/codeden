import {
  agentEventToNewEvent,
  type NewEvent,
  NOTICE_BATCH_CODE,
  type RunnerEventMessage,
} from "@codeden/contracts";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { mcpTokens, notices, sessions, turns, usageLedger } from "../db/schema";
import type { StoredStartMeta } from "../services/sessions/repo";
import type { Tx } from "./projection-db";
import type { ProjectionReader } from "./reducer/types";

function putMeta(tx: Tx, id: string, meta: StoredStartMeta) {
  tx.update(sessions).set({ startMeta: meta }).where(eq(sessions.id, id)).run();
}

function switchNotice(
  id: string,
  threadId: string,
  turnId: string,
  notice: { id: string; message: string },
) {
  return agentEventToNewEvent(id, {
    type: "item.completed",
    threadId,
    turnId,
    item: {
      ...notice,
      kind: "notice",
      status: "completed",
      level: "info",
      code: "pm_provider_switched",
    },
  });
}

/** Commit runner receipts with the runner's journal position, then fence the retired runtime. */
export function pmRuntimeEvents(
  tx: Tx,
  reader: ProjectionReader,
  msg: RunnerEventMessage,
  untrusted: boolean,
): NewEvent[] | undefined {
  const event = msg.event;
  if (
    event.kind !== "session.pmReplaced" &&
    event.kind !== "session.pmInputAccepted" &&
    event.kind !== "agent" &&
    event.kind !== "session.process"
  )
    return;
  const id = event.sessionId;
  const meta = tx
    .select({ meta: sessions.startMeta })
    .from(sessions)
    .where(eq(sessions.id, id))
    .get()?.meta;
  if (event.kind === "session.pmReplaced") {
    const pending = meta?.pmSwitch;
    const session = reader.getSession(id)?.session;
    if (untrusted || !meta || pending?.id !== event.runtimeId || session?.role !== "pm") return [];
    const notice = {
      id: `pm-provider-${event.runtimeId}`,
      message: `Project manager switched from ${pending.fromName} to ${pending.toName}${pending.model ? ` (${pending.model})` : ""}.`,
    };
    const lastTurn = tx
      .select({ id: turns.id })
      .from(turns)
      .where(and(eq(turns.sessionId, id), eq(turns.threadId, pending.rootId)))
      .orderBy(desc(turns.startedAt))
      .limit(1)
      .get();
    // Older turns have no provider/model columns. Keep their ledger's attribution before changing the session.
    tx.update(turns)
      .set({
        provider: sql`coalesce((select ${usageLedger.provider} from ${usageLedger}
        where ${usageLedger.sessionId} = ${turns.sessionId} and ${usageLedger.turnId} = ${turns.id}), ${session.provider})`,
        model: sql`coalesce((select ${usageLedger.model} from ${usageLedger}
        where ${usageLedger.sessionId} = ${turns.sessionId} and ${usageLedger.turnId} = ${turns.id}), ${session.model})`,
      })
      .where(and(eq(turns.sessionId, id), isNull(turns.provider)))
      .run();
    putMeta(tx, id, {
      ...meta,
      pmRuntimeId: pending.id,
      pmSwitch: undefined,
      pmPriorContext: pending.context,
      pmSwitchNotices: lastTurn ? meta.pmSwitchNotices : [...(meta.pmSwitchNotices ?? []), notice],
      vendorHistory: pending.vendorHistory,
      pendingConfig: undefined,
      startUnanswered: null,
      turnFromUser: false,
      workspaceStart: null,
    });
    tx.update(mcpTokens)
      .set({ revokedAt: msg.ts })
      .where(
        and(
          eq(mcpTokens.sessionId, id),
          isNull(mcpTokens.revokedAt),
          event.tokenId ? ne(mcpTokens.id, event.tokenId) : undefined,
        ),
      )
      .run();
    // Retain cumulative totals while letting the new runtime supply its own limits and context window.
    const {
      contextTokens: _tokens,
      contextWindow: _window,
      rateLimits: _limits,
      ...totals
    } = reader.getSession(id)?.usage ?? {};
    tx.update(sessions).set({ usage: totals }).where(eq(sessions.id, id)).run();

    const next = {
      ...session,
      provider: pending.provider,
      model: pending.model,
      effort: pending.effort,
      rootThreadId: pending.rootId,
      resumeToken: event.resumeToken,
      status: "idle" as const,
      startError: null,
      mcpServers: null,
      endedAt: null,
      updatedAt: msg.ts,
    };
    const out: NewEvent[] = [
      { type: "session.updated", sessionId: id, payload: { session: next } },
    ];
    if (lastTurn) out.push(switchNotice(id, pending.rootId, lastTurn.id, notice));
    return out;
  }
  if (event.runtimeId !== meta?.pmRuntimeId) return [];
  if (event.kind === "session.pmInputAccepted") {
    const delivery = meta?.pmDelivery;
    if (untrusted || !meta || delivery?.id !== event.deliveryId) return [];
    putMeta(tx, id, {
      ...meta,
      pmDelivery: undefined,
      pmPriorContext: undefined,
      pmLastDeliveryId: delivery.id,
      pmAcceptedNotices: delivery.noticeIds,
      turnFromUser:
        delivery.from === "user" ||
        (delivery.from === "orchestrator" && delivery.input.relayedForUser === true),
    });
    const out: NewEvent[] = [];
    if (delivery.queuedId)
      out.push({
        type: "message.dequeued",
        sessionId: id,
        payload: { sessionId: id, messageId: delivery.queuedId, reason: "sent" },
      });
    if (delivery.noticeIds.length)
      out.push({
        type: "notice.delivered",
        sessionId: null,
        payload: { noticeIds: delivery.noticeIds, at: msg.ts },
      });
    return out;
  }
  if (!meta?.pmRuntimeId || event.kind !== "agent" || event.event.type !== "turn.started") return;
  const turn = event.event;
  if (reader.getSession(id)?.session.rootThreadId !== turn.threadId) return;
  const out = [agentEventToNewEvent(id, turn)];
  for (const notice of meta.pmSwitchNotices ?? [])
    out.push(switchNotice(id, turn.threadId, turn.turnId, notice));
  if (meta.pmAcceptedNotices?.length) {
    const batch = tx
      .select({ notice: notices.notice })
      .from(notices)
      .where(inArray(notices.id, meta.pmAcceptedNotices))
      .all();
    const byId = new Map(batch.map((row) => [row.notice.id, row.notice]));
    const cards = meta.pmAcceptedNotices.flatMap((noticeId) => byId.get(noticeId) ?? []);
    out.push(
      agentEventToNewEvent(id, {
        type: "item.completed",
        threadId: turn.threadId,
        turnId: turn.turnId,
        item: {
          id: `notices-${turn.turnId}`,
          kind: "notice",
          level: "info",
          status: "completed",
          code: NOTICE_BATCH_CODE,
          message: `${cards.length} update${cards.length === 1 ? "" : "s"} since the last turn`,
          data: { notices: cards },
        },
      }),
    );
  }
  if (meta.pmSwitchNotices || meta.pmAcceptedNotices) {
    putMeta(tx, id, { ...meta, pmSwitchNotices: undefined, pmAcceptedNotices: undefined });
  }
  return out;
}
