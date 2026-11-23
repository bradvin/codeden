import type { AgentEvent, Item } from "@codeden/contracts";

/** Normalize a switched PM's provider-local ids before they enter the journal. */
export function pmTranscriptEvent(
  event: AgentEvent,
  runtime: string,
  nativeRoot: string | undefined,
  transcriptRoot: string,
  contextPrefix?: string,
): AgentEvent {
  const id = (local: string) => `${runtime}:${local}`;
  const thread = (local: string) => (local === nativeRoot ? transcriptRoot : id(local));
  if (event.type === "thread.started") {
    const t = event.thread;
    return {
      ...event,
      thread: {
        ...t,
        id: thread(t.id),
        parentThreadId: t.parentThreadId && thread(t.parentThreadId),
        parentItemId: t.parentItemId && id(t.parentItemId),
      },
    };
  }
  if (!("threadId" in event)) return event;
  const normalized = {
    ...event,
    threadId: thread(event.threadId),
    ...("turnId" in event && event.turnId ? { turnId: id(event.turnId) } : {}),
  } as AgentEvent;
  if ("itemId" in normalized) return { ...normalized, itemId: id(normalized.itemId) };
  if (!("item" in normalized)) return normalized;
  const item = normalized.item;
  let mapped: Item = { ...item, id: id(item.id) };
  if (item.kind === "subagent") {
    mapped = { ...item, id: id(item.id), childThreadId: thread(item.childThreadId) };
  } else if (item.kind === "approval_request" || item.kind === "user_question") {
    mapped = {
      ...item,
      id: id(item.id),
      requestId: id(item.requestId),
      ...("toolCallItemId" in item && item.toolCallItemId
        ? { toolCallItemId: id(item.toolCallItemId) }
        : {}),
    };
  } else if (
    item.kind === "user_message" &&
    contextPrefix &&
    item.input.text.startsWith(contextPrefix)
  ) {
    mapped = {
      ...item,
      id: id(item.id),
      input: { ...item.input, text: item.input.text.slice(contextPrefix.length) },
    };
  }
  return { ...normalized, item: mapped };
}
