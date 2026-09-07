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

/**
 * Returns only genuinely new messages from the other participant. Initial
 * transcript loads never call this helper, so durable history stays still.
 */
export function newlyArrivedIncomingMessageIds(
  current: readonly ConversationMessage[],
  delta: readonly ConversationMessage[],
  currentUserId: string | null,
  locallyOwnedMessageIds: ReadonlySet<string>,
): string[] {
  const knownIds = new Set(current.map((message) => message.messageId));
  return delta
    .filter(
      (message) =>
        !knownIds.has(message.messageId) &&
        message.senderUserId !== currentUserId &&
        !locallyOwnedMessageIds.has(message.messageId),
    )
    .map((message) => message.messageId);
}
