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
 * running one full draft lifecycle, one failed-and-cancelled draft, and one
 * two-agent round trip whose reply is opened against the collaborator's
 * approved message. Hand
 * written fixtures cannot catch a projection that renames a key, drops
 * BIGINT precision, or changes a timestamp format, because the same wrong
 * assumption would be written into both sides. These payloads can.
 *
 * Regenerate them whenever a conversation RPC's projection changes.
 */

const ownedDraftId = "a4000000-0000-4000-8000-000000000001";
const conversationId = "a3000000-0000-4000-8000-000000000001";
const ownerUserId = "a1000000-0000-4000-8000-000000000001";
const recipientDraftId = "a4000000-0000-4000-8000-000000000005";
const incomingMessageId = "a6000000-0000-4000-8000-000000000002";
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

  it("accepts the row returned by create_recipient_draft", async () => {
    const result = await repositoryReturning(
      payloads.recipientCreated,
    ).createRecipientDraft({
      draft: { draftId: recipientDraftId },
      idempotencyKey: "reply-owner-1",
    } as never);
    const draft = result?.draft;

    expect(result?.replayed).toBe(false);
    expect(draft?.role).toBe("recipient");
    expect(draft?.incomingMessageId).toBe(incomingMessageId);
    // Optional steering, not the owner's rough ask: a recipient draft answers
    // a message, so the column the sender flow requires is nullable here.
    expect(draft?.roughMessage).toBe("keep it short");
    expect(draft?.privateTurns).toEqual([
      { speaker: "owner", text: "keep it short" },
    ]);
  });

  it("keeps a sender draft free of any incoming message", async () => {
    const draft = await repositoryReturning(payloads.created).getDraft(ownedDraftId);

    expect(draft?.role).toBe("sender");
    expect(draft?.incomingMessageId).toBeNull();
  });

  it("refuses a reply to a message the owner sent themselves", async () => {
    const draft = await repositoryReturning(
      payloads.recipientRejectedOwnMessage,
    ).createRecipientDraft({
      draft: { draftId: recipientDraftId },
      idempotencyKey: "reply-rejected",
    } as never);

    expect(draft).toBeNull();
  });

  /**
   * The collaborator's text is the one string in the system that a stranger
   * wrote. It reaches the model exactly once, inside the untrusted data
   * envelope. If the loader also replayed it as ordinary shared history the
   * envelope would be decorative, so the SQL bounds history strictly earlier
   * than the message being answered and this pins that.
   */
  it("delivers the answered message only through the envelope field", () => {
    const recipient = payloads.recipientContext;

    expect(recipient.incomingMessage).toBe("Does rounding happen before or after tax?");
    expect(recipient.sharedHistory.map((entry) => entry.id)).toEqual([
      "a6000000-0000-4000-8000-000000000001",
    ]);
    // A sender turn opened at the same instant does see it, as plain history.
    expect(payloads.senderContext.sharedHistory.map((entry) => entry.id)).toContain(
      incomingMessageId,
    );
  });

  /**
   * `load_sender_protocol_context` hardcodes `'role', 'sender'` in its own
   * result, so a recipient row loaded through it would arrive claiming to be a
   * sender turn and the runtime adapter's purpose check could not see it. Each
   * loader has to reject the other role's rows itself.
   */
  it("keeps each role's durable loader blind to the other role's drafts", () => {
    expect(payloads.senderLoaderOnRecipientDraft).toBeNull();
    expect(payloads.recipientLoaderOnSenderDraft).toBeNull();
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
