import type { ConversationMessage } from "./api";

/** Appends a delta without duplicating an optimistic/local send. */
export function mergeConversationMessages(
  current: readonly ConversationMessage[],
  delta: readonly ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map(current.map((message) => [message.messageId, message]));
  for (const message of delta) byId.set(message.messageId, message);
  return [...byId.values()].sort(
    (left, right) =>
      left.sentAt.localeCompare(right.sentAt) ||
      left.messageId.localeCompare(right.messageId),
  );
}
