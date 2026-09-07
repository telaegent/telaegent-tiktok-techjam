import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "./api";
import {
  mergeConversationMessages,
  newlyArrivedIncomingMessageIds,
} from "./conversation-sync";

const message = (messageId: string, sentAt: string): ConversationMessage => ({
  messageId,
  conversationId: "conversation",
  githubRepositoryId: "123",
  senderUserId: "user",
  body: messageId,
  origin: "agent",
  provider: "codex",
  sentAt,
});

describe("mergeConversationMessages", () => {
  it("deduplicates a locally appended send and keeps canonical ordering", () => {
    const second = message("00000000-0000-4000-8000-000000000002", "2026-09-06T02:00:00.000Z");
    const first = message("00000000-0000-4000-8000-000000000001", "2026-09-06T01:00:00.000Z");
    expect(mergeConversationMessages([second], [first, second])).toEqual([first, second]);
  });

  it("identifies only new messages from the other participant", () => {
    const existing = message(
      "00000000-0000-4000-8000-000000000001",
      "2026-09-06T01:00:00.000Z",
    );
    const incoming = {
      ...message(
        "00000000-0000-4000-8000-000000000002",
        "2026-09-06T02:00:00.000Z",
      ),
      senderUserId: "peer-user",
    };
    const own = message(
      "00000000-0000-4000-8000-000000000003",
      "2026-09-06T03:00:00.000Z",
    );

    expect(
      newlyArrivedIncomingMessageIds(
        [existing],
        [existing, incoming, own],
        "user",
        new Set(),
      ),
    ).toEqual([incoming.messageId]);
  });

  it("does not replay optimistic messages returned by polling", () => {
    const optimistic = message(
      "00000000-0000-4000-8000-000000000004",
      "2026-09-06T04:00:00.000Z",
    );
    expect(
      newlyArrivedIncomingMessageIds(
        [],
        [optimistic],
        null,
        new Set([optimistic.messageId]),
      ),
    ).toEqual([]);
  });
});
