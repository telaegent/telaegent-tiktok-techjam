import { describe, expect, it, vi } from "vitest";
import type { PrivateDraft } from "./types.js";
import {
  maximumSharedMessagesPerRead,
  SupabaseConversationRepository,
  SupabaseConversationRepositoryError,
  type ConversationRpcFunction,
  type SupabaseConversationClient,
} from "./supabase-conversation-repository.js";

const draftId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const messageId = "55555555-5555-4555-8555-555555555555";
const approvalId = "66666666-6666-4666-8666-666666666666";
const githubRepositoryId = "1345851083";
const timestamp = "2026-08-31T09:00:00.000Z";

function draftRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    draftId,
    conversationId,
    githubRepositoryId,
    ownerUserId,
    provider: "codex",
    role: "sender",
    roughMessage: "why does the checkout total drift by a cent",
    incomingMessageId: null,
    privateTurns: [{ speaker: "owner", text: "why does the total drift" }],
    state: "ready",
    turnId,
    privateMessage: "Rounding happens before tax is applied.",
    sendCandidate: "Rounding happens before tax is applied.",
    riskFlags: ["ambiguous_request"],
    guardFindings: [
      {
        code: "GUARD_EMPTY_CANDIDATE",
        safeReason: "The draft had nothing to send.",
        impliedFlag: "ambiguous_request",
      },
    ],
    failure: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    sentMessageId: null,
    ...overrides,
  };
}

function messageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId,
    conversationId,
    githubRepositoryId,
    senderUserId: ownerUserId,
    body: "Rounding happens before tax is applied.",
    origin: "agent",
    provider: "codex",
    sentAt: timestamp,
    ...overrides,
  };
}

function approvalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approvalId,
    draftId,
    messageId,
    actorUserId: ownerUserId,
    approvedBody: "Rounding happens before tax is applied.",
    idempotencyKey: "send-1",
    approvedAt: timestamp,
    ...overrides,
  };
}

interface RecordedCall {
  functionName: ConversationRpcFunction;
  params: Record<string, unknown>;
}

function fakeClient(result: unknown | (() => unknown)): {
  client: SupabaseConversationClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: SupabaseConversationClient = {
    async callConversationRpc(functionName, params) {
      calls.push({ functionName, params: { ...params } });
      return typeof result === "function" ? (result as () => unknown)() : result;
    },
  };
  return { client, calls };
}

function repositoryReturning(result: unknown | (() => unknown)): {
  repository: SupabaseConversationRepository;
  calls: RecordedCall[];
} {
  const { client, calls } = fakeClient(result);
  return { repository: new SupabaseConversationRepository(client), calls };
}

const sampleDraft: PrivateDraft = {
  draftId,
  conversationId,
  githubRepositoryId,
  ownerUserId,
  provider: "codex",
  role: "sender",
  roughMessage: "why does the checkout total drift by a cent",
  incomingMessageId: null,
  privateTurns: [],
  state: "created",
  turnId: null,
  privateMessage: null,
  sendCandidate: null,
  riskFlags: [],
  guardFindings: [],
  failure: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  sentMessageId: null,
};

describe("SupabaseConversationRepository", () => {
  it("creates a draft through create_private_draft and returns the stored row", async () => {
    const { repository, calls } = repositoryReturning(draftRow({ state: "created" }));

    const created = await repository.createDraft(sampleDraft);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.functionName).toBe("create_private_draft");
    expect(calls[0]?.params).toEqual({
      p_draft_id: draftId,
      p_conversation_id: conversationId,
      p_github_repository_id: githubRepositoryId,
      p_owner_user_id: ownerUserId,
      p_provider: "codex",
      p_rough_message: sampleDraft.roughMessage,
      p_created_at: timestamp,
      p_updated_at: timestamp,
    });
    expect(created.state).toBe("created");
  });

  it("keeps the GitHub repository ID a decimal string so BIGINT precision survives", async () => {
    const largeId = "9223372036854775807";
    const { repository, calls } = repositoryReturning(
      draftRow({ githubRepositoryId: largeId }),
    );

    const created = await repository.createDraft({
      ...sampleDraft,
      githubRepositoryId: largeId,
    });

    expect(calls[0]?.params.p_github_repository_id).toBe(largeId);
    expect(created.githubRepositoryId).toBe(largeId);
  });

  it("reads a draft through get_private_draft", async () => {
    const { repository, calls } = repositoryReturning(draftRow());

    const draft = await repository.getDraft(draftId);

    expect(calls[0]).toEqual({
      functionName: "get_private_draft",
      params: { p_draft_id: draftId },
    });
    expect(draft?.draftId).toBe(draftId);
  });

  it("creates a recipient draft with an owner-scoped idempotency key", async () => {
    const recipient = {
      ...sampleDraft,
      role: "recipient" as const,
      roughMessage: "keep it short",
      incomingMessageId: messageId,
      privateTurns: [{ speaker: "owner" as const, text: "keep it short" }],
    };
    const { repository, calls } = repositoryReturning({
      draft: draftRow({
        role: "recipient",
        roughMessage: "keep it short",
        incomingMessageId: messageId,
        privateTurns: [{ speaker: "owner", text: "keep it short" }],
        state: "created",
      }),
      replayed: false,
    });

    const result = await repository.createRecipientDraft({
      draft: recipient,
      idempotencyKey: "reply-1",
    });

    expect(calls[0]).toEqual({
      functionName: "create_recipient_draft",
      params: {
        p_draft_id: draftId,
        p_conversation_id: conversationId,
        p_github_repository_id: githubRepositoryId,
        p_owner_user_id: ownerUserId,
        p_provider: "codex",
        p_incoming_message_id: messageId,
        p_owner_guidance: "keep it short",
        p_idempotency_key: "reply-1",
        p_created_at: timestamp,
        p_updated_at: timestamp,
      },
    });
    expect(result?.replayed).toBe(false);
    expect(result?.draft.privateTurns).toEqual([
      { speaker: "owner", text: "keep it short" },
    ]);
  });

  it("marks a draft running with the owner and turn the caller claims", async () => {
    const { repository, calls } = repositoryReturning(
      draftRow({ state: "agent_working" }),
    );

    await repository.markDraftRunning({
      draftId,
      ownerUserId,
      turnId,
      updatedAt: timestamp,
    });

    expect(calls[0]).toEqual({
      functionName: "mark_private_draft_running",
      params: {
        p_draft_id: draftId,
        p_owner_user_id: ownerUserId,
        p_turn_id: turnId,
        p_updated_at: timestamp,
      },
    });
  });

  it("completes a draft with the expected turn, flags and findings", async () => {
    const { repository, calls } = repositoryReturning(draftRow());

    await repository.completeDraft({
      draftId,
      expectedTurnId: turnId,
      state: "ready",
      privateMessage: "Rounding happens before tax is applied.",
      sendCandidate: "Rounding happens before tax is applied.",
      riskFlags: ["ambiguous_request"],
      guardFindings: [],
      updatedAt: timestamp,
    });

    expect(calls[0]).toEqual({
      functionName: "complete_private_draft",
      params: {
        p_draft_id: draftId,
        p_expected_turn_id: turnId,
        p_state: "ready",
        p_private_message: "Rounding happens before tax is applied.",
        p_send_candidate: "Rounding happens before tax is applied.",
        p_risk_flags: ["ambiguous_request"],
        p_guard_findings: [],
        p_updated_at: timestamp,
      },
    });
  });

  it("adds an owner clarification", async () => {
    const { repository, calls } = repositoryReturning(draftRow({ state: "created" }));

    await repository.addOwnerClarification({
      draftId,
      ownerUserId,
      content: "only the EU storefront",
      updatedAt: timestamp,
    });

    expect(calls[0]).toEqual({
      functionName: "add_private_draft_clarification",
      params: {
        p_draft_id: draftId,
        p_owner_user_id: ownerUserId,
        p_content: "only the EU storefront",
        p_updated_at: timestamp,
      },
    });
  });

  it("records a runtime failure", async () => {
    const failure = {
      code: "RUNTIME_UNAVAILABLE",
      message: "No local connector is attached",
      retryable: true,
    } as const;
    const { repository, calls } = repositoryReturning(
      draftRow({ state: "runtime_failed", failure }),
    );

    const failed = await repository.markDraftFailed({
      draftId,
      expectedTurnId: turnId,
      privateMessage: "The agent could not run.",
      failure,
      updatedAt: timestamp,
    });

    expect(calls[0]?.functionName).toBe("mark_private_draft_failed");
    expect(calls[0]?.params.p_failure).toEqual(failure);
    expect(failed?.failure).toEqual(failure);
  });

  it("sends an absent expected turn as SQL NULL when cancelling", async () => {
    const { repository, calls } = repositoryReturning(draftRow({ state: "cancelled" }));

    await repository.cancelDraft({ draftId, ownerUserId, updatedAt: timestamp });

    expect(calls[0]?.params.p_expected_turn_id).toBeNull();
  });

  it("sends a draft and reports a first delivery", async () => {
    const { repository, calls } = repositoryReturning({
      message: messageRow(),
      approval: approvalRow(),
      replayed: false,
    });

    const result = await repository.sendDraft({
      draftId,
      ownerUserId,
      approvedBody: "Rounding happens before tax is applied.",
      idempotencyKey: "send-1",
      message: messageRow() as never,
      approval: approvalRow() as never,
      updatedAt: timestamp,
    });

    expect(calls[0]?.functionName).toBe("send_private_draft");
    expect(calls[0]?.params).toEqual({
      p_draft_id: draftId,
      p_owner_user_id: ownerUserId,
      p_approved_body: "Rounding happens before tax is applied.",
      p_idempotency_key: "send-1",
      p_message_id: messageId,
      p_conversation_id: conversationId,
      p_github_repository_id: githubRepositoryId,
      p_provider: "codex",
      p_sent_at: timestamp,
      p_approval_id: approvalId,
      p_approved_at: timestamp,
      p_updated_at: timestamp,
    });
    expect(result?.replayed).toBe(false);
    expect(result?.message.messageId).toBe(messageId);
  });

  it("preserves the replayed flag so a retry does not appear as a second send", async () => {
    const { repository } = repositoryReturning({
      message: messageRow(),
      approval: approvalRow(),
      replayed: true,
    });

    const result = await repository.sendDraft({
      draftId,
      ownerUserId,
      approvedBody: "Rounding happens before tax is applied.",
      idempotencyKey: "send-1",
      message: messageRow() as never,
      approval: approvalRow() as never,
      updatedAt: timestamp,
    });

    expect(result?.replayed).toBe(true);
  });

  it("lists shared messages under a bounded read", async () => {
    const { repository, calls } = repositoryReturning([messageRow()]);

    const messages = await repository.listMessages(conversationId);

    expect(calls[0]).toEqual({
      functionName: "list_shared_messages",
      params: {
        p_conversation_id: conversationId,
        p_limit: maximumSharedMessagesPerRead + 1,
      },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.origin).toBe("agent");
  });

  it("returns an empty transcript without treating it as a failure", async () => {
    const { repository } = repositoryReturning([]);

    await expect(repository.listMessages(conversationId)).resolves.toEqual([]);
  });

  describe("guard rejections", () => {
    it("maps a refused lifecycle transition to null rather than an error", async () => {
      const { repository } = repositoryReturning(null);

      await expect(
        repository.markDraftRunning({
          draftId,
          ownerUserId,
          turnId,
          updatedAt: timestamp,
        }),
      ).resolves.toBeNull();
      await expect(repository.getDraft(draftId)).resolves.toBeNull();
      await expect(
        repository.cancelDraft({ draftId, ownerUserId, updatedAt: timestamp }),
      ).resolves.toBeNull();
    });

    it("maps a refused send to null", async () => {
      const { repository } = repositoryReturning(null);

      await expect(
        repository.sendDraft({
          draftId,
          ownerUserId,
          approvedBody: "body",
          idempotencyKey: "send-1",
          message: messageRow() as never,
          approval: approvalRow() as never,
          updatedAt: timestamp,
        }),
      ).resolves.toBeNull();
    });

    it("never silently invents a draft when creation returns nothing", async () => {
      const { repository } = repositoryReturning(null);

      await expect(repository.createDraft(sampleDraft)).rejects.toMatchObject({
        code: "INVALID_SUPABASE_CONVERSATION_RECORD",
      });
    });
  });

  describe("untrusted payload rejection", () => {
    const invalidRows: ReadonlyArray<readonly [string, unknown]> = [
      ["an unknown column", draftRow({ providerSessionId: "session-1" })],
      ["a missing column", (() => {
        const row = draftRow();
        delete row.updatedAt;
        return row;
      })()],
      ["an unknown lifecycle state", draftRow({ state: "approved" })],
      ["an unknown risk flag", draftRow({ riskFlags: ["totally_fine"] })],
      ["a non-canonical repository ID", draftRow({ githubRepositoryId: "0123" })],
      ["a non-UUID identifier", draftRow({ draftId: "draft-1" })],
      ["a non-ISO timestamp", draftRow({ createdAt: "2026-08-31 09:00:00" })],
      ["an empty private message", draftRow({ privateMessage: "" })],
      ["a lowercase guard code", draftRow({
        guardFindings: [
          {
            code: "guard_empty_candidate",
            safeReason: "The draft had nothing to send.",
            impliedFlag: "ambiguous_request",
          },
        ],
      })],
      ["a guard finding quoting extra fields", draftRow({
        guardFindings: [
          {
            code: "GUARD_EMPTY_CANDIDATE",
            safeReason: "The draft had nothing to send.",
            impliedFlag: "ambiguous_request",
            offendingText: "sk-live-secret",
          },
        ],
      })],
      ["an unparseable response", undefined],
    ];

    for (const [label, row] of invalidRows) {
      it("rejects " + label, async () => {
        const { repository } = repositoryReturning(row);

        await expect(repository.getDraft(draftId)).rejects.toMatchObject({
          code: "INVALID_SUPABASE_CONVERSATION_RECORD",
        });
      });
    }

    it("rejects a shared message that is not agent-originated", async () => {
      const { repository } = repositoryReturning([messageRow({ origin: "human" })]);

      await expect(repository.listMessages(conversationId)).rejects.toMatchObject({
        code: "INVALID_SUPABASE_CONVERSATION_RECORD",
      });
    });

    it("rejects a transcript larger than the bounded read instead of truncating it", async () => {
      const oversized = Array.from({ length: maximumSharedMessagesPerRead + 1 }, () =>
        messageRow(),
      );
      const { repository } = repositoryReturning(oversized);

      await expect(repository.listMessages(conversationId)).rejects.toMatchObject({
        code: "CONVERSATION_TRANSCRIPT_TOO_LARGE",
      });
    });

    it("serves a transcript that exactly fills the bound", async () => {
      const full = Array.from({ length: maximumSharedMessagesPerRead }, () =>
        messageRow(),
      );
      const { repository } = repositoryReturning(full);

      await expect(repository.listMessages(conversationId)).resolves.toHaveLength(
        maximumSharedMessagesPerRead,
      );
    });

    it("rejects a response that ignores the requested bound entirely", async () => {
      const runaway = Array.from({ length: maximumSharedMessagesPerRead + 2 }, () =>
        messageRow(),
      );
      const { repository } = repositoryReturning(runaway);

      await expect(repository.listMessages(conversationId)).rejects.toMatchObject({
        code: "INVALID_SUPABASE_CONVERSATION_RECORD",
      });
    });

    it("rejects a send result whose approval does not match the schema", async () => {
      const { repository } = repositoryReturning({
        message: messageRow(),
        approval: approvalRow({ idempotencyKey: "send 1" }),
        replayed: false,
      });

      await expect(
        repository.sendDraft({
          draftId,
          ownerUserId,
          approvedBody: "body",
          idempotencyKey: "send-1",
          message: messageRow() as never,
          approval: approvalRow() as never,
          updatedAt: timestamp,
        }),
      ).rejects.toMatchObject({ code: "INVALID_SUPABASE_CONVERSATION_RECORD" });
    });
  });

  describe("failure reporting", () => {
    it("reports transport failure as an availability error", async () => {
      const client: SupabaseConversationClient = {
        callConversationRpc: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      };
      const repository = new SupabaseConversationRepository(client);

      await expect(repository.getDraft(draftId)).rejects.toMatchObject({
        code: "SUPABASE_CONVERSATION_UNAVAILABLE",
      });
    });

    it("never leaks row content, SQL detail or transport detail", async () => {
      const secretBearingError = new Error(
        "insert into private_drafts failed: sb_secret_leaked at https://project.supabase.co",
      );
      const client: SupabaseConversationClient = {
        callConversationRpc: vi.fn().mockRejectedValue(secretBearingError),
      };
      const repository = new SupabaseConversationRepository(client);

      const error = await repository
        .getDraft(draftId)
        .then(() => null)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SupabaseConversationRepositoryError);
      const serialized = String(error) + JSON.stringify(error);
      expect(serialized).not.toContain("sb_secret_leaked");
      expect(serialized).not.toContain("supabase.co");
      expect(serialized).not.toContain("private_drafts");
    });

    it("does not disclose the rejected payload", async () => {
      const { repository } = repositoryReturning(
        draftRow({ roughMessage: "the api key is sk-live-not-a-real-key" , state: "approved" }),
      );

      const error = await repository
        .getDraft(draftId)
        .then(() => null)
        .catch((caught: unknown) => caught);

      const serialized = String(error) + JSON.stringify(error);
      expect(serialized).not.toContain("sk-live-not-a-real-key");
      expect(serialized).not.toContain("approved");
    });
  });
});
