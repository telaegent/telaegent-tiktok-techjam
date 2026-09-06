import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "./api";
import { mergeConversationMessages } from "./conversation-sync";

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
});
