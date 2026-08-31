import { describe, expect, it } from "vitest";
import payloads from "./conversation-rpc-payloads.fixture.json" with { type: "json" };
import {
  SupabaseConversationRepository,
  type ConversationRpcFunction,
  type SupabaseConversationClient,
} from "./supabase-conversation-repository.js";

/**
 * Pins the SQL projections to the adapter's schemas.
 *
 * `conversation-rpc-payloads.fixture.json` is verbatim output captured by
 * applying every migration in `supabase/migrations` to PostgreSQL 16 and
 * running one full draft lifecycle plus one failed-and-cancelled draft. Hand
 * written fixtures cannot catch a projection that renames a key, drops
 * BIGINT precision, or changes a timestamp format, because the same wrong
 * assumption would be written into both sides. These payloads can.
 *
 * Regenerate them whenever a conversation RPC's projection changes.
 */

const ownedDraftId = "a4000000-0000-4000-8000-000000000001";
const conversationId = "a3000000-0000-4000-8000-000000000001";
const ownerUserId = "a1000000-0000-4000-8000-000000000001";
const largestBigint = "9223372036854775807";

function repositoryReturning(result: unknown): SupabaseConversationRepository {
  const client: SupabaseConversationClient = {
    async callConversationRpc(_functionName: ConversationRpcFunction) {
      return result;
    },
  };
  return new SupabaseConversationRepository(client);
}

const draftStates: ReadonlyArray<readonly [string, unknown, string]> = [
  ["create_private_draft", payloads.created, "created"],
  ["mark_private_draft_running", payloads.running, "agent_working"],
  [
    "complete_private_draft asking for clarification",
    payloads.needsClarification,
    "needs_clarification",
  ],
  ["add_private_draft_clarification", payloads.clarified, "created"],
  ["mark_private_draft_running on a rerun", payloads.rerunning, "agent_working"],
  ["complete_private_draft with a candidate", payloads.ready, "ready"],
  ["get_private_draft after a send", payloads.fetched, "sent"],
  ["mark_private_draft_failed", payloads.failed, "runtime_failed"],
  ["cancel_private_draft", payloads.cancelled, "cancelled"],
];

describe("conversation RPC payload contract", () => {
  for (const [label, payload, expectedState] of draftStates) {
    it("accepts the row returned by " + label, async () => {
      const draft = await repositoryReturning(payload).getDraft(ownedDraftId);

      expect(draft?.state).toBe(expectedState);
    });
  }

  it("keeps the largest BIGINT repository ID exact across the boundary", async () => {
    const draft = await repositoryReturning(payloads.created).getDraft(ownedDraftId);

    expect(draft?.githubRepositoryId).toBe(largestBigint);
  });

  it("emits timestamps in the ISO form the schema requires", async () => {
    const draft = await repositoryReturning(payloads.created).getDraft(ownedDraftId);

    expect(draft?.createdAt).toBe("2026-08-31T09:00:00.000Z");
  });

  it("appends the agent turn only when clarification is requested", async () => {
    const asked = await repositoryReturning(payloads.needsClarification).getDraft(
      ownedDraftId,
    );
    const answered = await repositoryReturning(payloads.clarified).getDraft(
      ownedDraftId,
    );

    expect(asked?.privateTurns).toEqual([
      { speaker: "agent", text: "which storefront?" },
    ]);
    expect(answered?.privateTurns).toEqual([
      { speaker: "agent", text: "which storefront?" },
      { speaker: "owner", text: "only the EU storefront" },
    ]);
  });

  it("returns a normalized failure carrying no runtime internals", async () => {
    const draft = await repositoryReturning(payloads.failed).getDraft(ownedDraftId);

    expect(draft?.failure).toEqual({
      code: "RUNTIME_UNAVAILABLE",
      message: "No local connector is attached",
      retryable: true,
    });
  });

  it("accepts the send result and reports a first delivery", async () => {
    const result = await repositoryReturning(payloads.sent).sendDraft({
      draftId: ownedDraftId,
      ownerUserId,
      approvedBody: "Rounding is applied before tax.",
      idempotencyKey: "send-1",
      message: {} as never,
      approval: {} as never,
      updatedAt: "2026-08-31T09:00:06.000Z",
    });

    expect(result?.replayed).toBe(false);
    expect(result?.message.githubRepositoryId).toBe(largestBigint);
    expect(result?.approval.idempotencyKey).toBe("send-1");
  });

  it("accepts the shared transcript and marks it agent-originated", async () => {
    const messages = await repositoryReturning(payloads.listed).listMessages(
      conversationId,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      messageId: "a6000000-0000-4000-8000-000000000001",
      conversationId,
      githubRepositoryId: largestBigint,
      senderUserId: ownerUserId,
      body: "Rounding is applied before tax.",
      origin: "agent",
      provider: "codex",
      sentAt: "2026-08-31T09:00:06.000Z",
    });
  });

  it("never projects a credential, session reference or raw provider stream", () => {
    const forbidden = [
      "secret",
      "token",
      "credential",
      "apikey",
      "api_key",
      "session",
      "workspace",
      "codexhome",
      "reasoning",
      "stream",
      "stdout",
      "stderr",
    ];
    const serialized = JSON.stringify(payloads).toLowerCase();

    for (const term of forbidden) {
      expect(serialized).not.toContain(term);
    }
  });
});
