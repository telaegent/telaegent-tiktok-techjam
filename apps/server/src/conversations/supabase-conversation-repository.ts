import { z } from "zod";
import { isGitHubRepositoryId } from "../authorization/github-repository-id.js";
import type { PublicRuntimeErrorCode } from "../runtime-contract.js";
import { PROTOCOL_LIMITS, RISK_FLAGS } from "../telagent/protocol/contract.js";
import type { GuardCode } from "../telagent/protocol/guards.js";
import type {
  CompleteDraftInput,
  ConversationRepository,
  SendDraftInput,
} from "./repository.js";
import type {
  PrivateDraft,
  PrivateDraftFailure,
  SendDraftResult,
  SharedMessage,
} from "./types.js";

/**
 * Largest approved body the send route accepts, and therefore the widest text
 * that can reach `sendCandidate` or a shared message body.
 */
const maximumApprovedBodyChars = 50_000;
const maximumSafeReasonChars = 1_000;
/**
 * Upper bound on one transcript read.
 *
 * `ConversationRepository.listMessages` has no cursor, so this is a ceiling
 * rather than a page size. The read asks the database for one message beyond
 * it, so a conversation that has outgrown the bound is reported rather than
 * served as a silently truncated transcript: approved messages are canonical
 * project memory, and showing the oldest thousand of a longer history would
 * hide the most recent exchanges and invite replies against stale context.
 * Raising this is not the fix; a cursor on the repository interface is.
 */
export const maximumSharedMessagesPerRead = 1_000;

/** Every conversation RPC this adapter is permitted to call. */
const conversationRpcFunctions = [
  "create_private_draft",
  "get_private_draft",
  "mark_private_draft_running",
  "complete_private_draft",
  "add_private_draft_clarification",
  "mark_private_draft_failed",
  "cancel_private_draft",
  "send_private_draft",
  "list_shared_messages",
] as const;

export type ConversationRpcFunction = (typeof conversationRpcFunctions)[number];

export interface SupabaseConversationClient {
  /**
   * Calls one conversation RPC, which is one database transaction, and returns
   * its untrusted JSON result. Implementations must never select credentials,
   * provider session references, or another user's private draft.
   */
  callConversationRpc(
    functionName: ConversationRpcFunction,
    params: Readonly<Record<string, unknown>>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown>;
}

export type SupabaseConversationRepositoryErrorCode =
  | "SUPABASE_CONVERSATION_UNAVAILABLE"
  | "INVALID_SUPABASE_CONVERSATION_RECORD"
  | "CONVERSATION_TRANSCRIPT_TOO_LARGE";

const errorMessages: Readonly<
  Record<SupabaseConversationRepositoryErrorCode, string>
> = {
  SUPABASE_CONVERSATION_UNAVAILABLE:
    "Conversation persistence is temporarily unavailable",
  INVALID_SUPABASE_CONVERSATION_RECORD:
    "Conversation persistence returned an invalid record",
  CONVERSATION_TRANSCRIPT_TOO_LARGE:
    "Conversation transcript is too large to read without pagination",
};

/** Safe infrastructure error: never includes row data, paths, or Zod issues. */
export class SupabaseConversationRepositoryError extends Error {
  constructor(public readonly code: SupabaseConversationRepositoryErrorCode) {
    super(errorMessages[code]);
    this.name = "SupabaseConversationRepositoryError";
  }
}

// Every identifier column in the conversation schema is a Postgres `uuid`, so
// the stored shape is checked directly rather than through a version-aware
// validator that could reject a legitimately stored value.
const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const isoTimestampSchema = z.string().datetime({ offset: true });
const githubRepositoryIdSchema = z.string().refine(isGitHubRepositoryId);
const providerSchema = z.enum(["codex", "claude"]);
const riskFlagSchema = z.enum(RISK_FLAGS);

/**
 * Guard and runtime codes are unions assembled from several vocabularies and
 * are advisory audit/UI data rather than authorization inputs. Validating their
 * shape keeps the row bounded without making persistence break every time the
 * protocol gains a code.
 */
const codePattern = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
const guardCodeSchema = codePattern.transform((value) => value as GuardCode);
const failureCodeSchema = codePattern.transform(
  (value) => value as PublicRuntimeErrorCode,
);

const privateTurnSchema = z.strictObject({
  speaker: z.enum(["owner", "agent"]),
  text: z.string().min(1).max(PROTOCOL_LIMITS.maxPrivateMessageChars),
});

const guardFindingSchema = z.strictObject({
  code: guardCodeSchema,
  safeReason: z.string().min(1).max(maximumSafeReasonChars),
  impliedFlag: riskFlagSchema,
});

const failureSchema = z.strictObject({
  code: failureCodeSchema,
  message: z.string().min(1).max(maximumSafeReasonChars),
  retryable: z.boolean(),
});

const privateDraftSchema = z.strictObject({
  draftId: uuidSchema,
  conversationId: uuidSchema,
  githubRepositoryId: githubRepositoryIdSchema,
  ownerUserId: uuidSchema,
  provider: providerSchema,
  roughMessage: z.string().min(1).max(PROTOCOL_LIMITS.maxPrivateMessageChars),
  privateTurns: z.array(privateTurnSchema).max(32),
  state: z.enum([
    "created",
    "agent_working",
    "needs_clarification",
    "ready",
    "blocked",
    "runtime_failed",
    "cancelled",
    "sent",
  ]),
  turnId: uuidSchema.nullable(),
  privateMessage: z
    .string()
    .min(1)
    .max(PROTOCOL_LIMITS.maxPrivateMessageChars)
    .nullable(),
  sendCandidate: z.string().min(1).max(maximumApprovedBodyChars).nullable(),
  riskFlags: z.array(riskFlagSchema).max(32),
  guardFindings: z.array(guardFindingSchema).max(32),
  failure: failureSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  sentMessageId: uuidSchema.nullable(),
});

const sharedMessageSchema = z.strictObject({
  messageId: uuidSchema,
  conversationId: uuidSchema,
  githubRepositoryId: githubRepositoryIdSchema,
  senderUserId: uuidSchema,
  body: z.string().min(1).max(maximumApprovedBodyChars),
  origin: z.literal("agent"),
  provider: providerSchema,
  sentAt: isoTimestampSchema,
});

const outboundApprovalSchema = z.strictObject({
  approvalId: uuidSchema,
  draftId: uuidSchema,
  messageId: uuidSchema,
  actorUserId: uuidSchema,
  approvedBody: z.string().min(1).max(maximumApprovedBodyChars),
  idempotencyKey: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  approvedAt: isoTimestampSchema,
});

const sendDraftResultSchema = z.strictObject({
  message: sharedMessageSchema,
  approval: outboundApprovalSchema,
  replayed: z.boolean(),
});

// One beyond the ceiling, so an overflowing transcript is detected rather than
// rejected as a malformed payload.
const sharedMessageListSchema = z
  .array(sharedMessageSchema)
  .max(maximumSharedMessagesPerRead + 1);

/**
 * Supabase-backed canonical conversation persistence.
 *
 * Each method is exactly one RPC, therefore exactly one database transaction.
 * `sendDraft` in particular commits the approval, the shared message, and the
 * draft's sent state together, which is the atomicity `ConversationRepository`
 * requires of durable adapters.
 *
 * A SQL NULL result means a lifecycle guard rejected the call, and is mapped to
 * the interface's `null`. It is never conflated with a transport failure.
 */
export class SupabaseConversationRepository implements ConversationRepository {
  constructor(private readonly client: SupabaseConversationClient) {}

  async createDraft(draft: PrivateDraft): Promise<PrivateDraft> {
    const record = await this.call("create_private_draft", {
      p_draft_id: draft.draftId,
      p_conversation_id: draft.conversationId,
      // Preserve BIGINT precision by keeping the canonical decimal string.
      p_github_repository_id: draft.githubRepositoryId,
      p_owner_user_id: draft.ownerUserId,
      p_provider: draft.provider,
      p_rough_message: draft.roughMessage,
      p_created_at: draft.createdAt,
      p_updated_at: draft.updatedAt,
    });
    const created = parseDraft(record);
    if (!created) {
      throw new SupabaseConversationRepositoryError(
        "INVALID_SUPABASE_CONVERSATION_RECORD",
      );
    }
    return created;
  }

  async getDraft(draftId: string): Promise<PrivateDraft | null> {
    return parseDraft(await this.call("get_private_draft", { p_draft_id: draftId }));
  }

  async markDraftRunning(input: {
    draftId: string;
    ownerUserId: string;
    turnId: string;
    updatedAt: string;
  }): Promise<PrivateDraft | null> {
    return parseDraft(
      await this.call("mark_private_draft_running", {
        p_draft_id: input.draftId,
        p_owner_user_id: input.ownerUserId,
        p_turn_id: input.turnId,
        p_updated_at: input.updatedAt,
      }),
    );
  }

  async completeDraft(input: CompleteDraftInput): Promise<PrivateDraft | null> {
    return parseDraft(
      await this.call("complete_private_draft", {
        p_draft_id: input.draftId,
        p_expected_turn_id: input.expectedTurnId,
        p_state: input.state,
        p_private_message: input.privateMessage,
        p_send_candidate: input.sendCandidate,
        p_risk_flags: input.riskFlags,
        p_guard_findings: input.guardFindings,
        p_updated_at: input.updatedAt,
      }),
    );
  }

  async addOwnerClarification(input: {
    draftId: string;
    ownerUserId: string;
    content: string;
    updatedAt: string;
  }): Promise<PrivateDraft | null> {
    return parseDraft(
      await this.call("add_private_draft_clarification", {
        p_draft_id: input.draftId,
        p_owner_user_id: input.ownerUserId,
        p_content: input.content,
        p_updated_at: input.updatedAt,
      }),
    );
  }

  async markDraftFailed(input: {
    draftId: string;
    expectedTurnId: string;
    privateMessage: string;
    failure: PrivateDraftFailure;
    updatedAt: string;
  }): Promise<PrivateDraft | null> {
    return parseDraft(
      await this.call("mark_private_draft_failed", {
        p_draft_id: input.draftId,
        p_expected_turn_id: input.expectedTurnId,
        p_private_message: input.privateMessage,
        p_failure: input.failure,
        p_updated_at: input.updatedAt,
      }),
    );
  }

  async cancelDraft(input: {
    draftId: string;
    ownerUserId: string;
    expectedTurnId?: string | undefined;
    updatedAt: string;
  }): Promise<PrivateDraft | null> {
    return parseDraft(
      await this.call("cancel_private_draft", {
        p_draft_id: input.draftId,
        p_owner_user_id: input.ownerUserId,
        p_expected_turn_id: input.expectedTurnId ?? null,
        p_updated_at: input.updatedAt,
      }),
    );
  }

  async sendDraft(input: SendDraftInput): Promise<SendDraftResult | null> {
    const record = await this.call("send_private_draft", {
      p_draft_id: input.draftId,
      p_owner_user_id: input.ownerUserId,
      p_approved_body: input.approvedBody,
      p_idempotency_key: input.idempotencyKey,
      p_message_id: input.message.messageId,
      p_conversation_id: input.message.conversationId,
      p_github_repository_id: input.message.githubRepositoryId,
      p_provider: input.message.provider,
      p_sent_at: input.message.sentAt,
      p_approval_id: input.approval.approvalId,
      p_approved_at: input.approval.approvedAt,
      p_updated_at: input.updatedAt,
    });
    // Only a SQL NULL is a guard rejection. `undefined` means the transport
    // could not parse a successful response, which is an invalid payload.
    if (record === null) return null;
    const parsed = sendDraftResultSchema.safeParse(record);
    if (!parsed.success) {
      throw new SupabaseConversationRepositoryError(
        "INVALID_SUPABASE_CONVERSATION_RECORD",
      );
    }
    return parsed.data;
  }

  async listMessages(conversationId: string): Promise<SharedMessage[]> {
    const record = await this.call("list_shared_messages", {
      p_conversation_id: conversationId,
      // One beyond the ceiling: the database applies the limit, so asking for
      // exactly the ceiling could not tell a complete transcript apart from a
      // truncated one.
      p_limit: maximumSharedMessagesPerRead + 1,
    });
    const parsed = sharedMessageListSchema.safeParse(record);
    if (!parsed.success) {
      throw new SupabaseConversationRepositoryError(
        "INVALID_SUPABASE_CONVERSATION_RECORD",
      );
    }
    if (parsed.data.length > maximumSharedMessagesPerRead) {
      throw new SupabaseConversationRepositoryError(
        "CONVERSATION_TRANSCRIPT_TOO_LARGE",
      );
    }
    return parsed.data;
  }

  private async call(
    functionName: ConversationRpcFunction,
    params: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    try {
      return await this.client.callConversationRpc(functionName, params);
    } catch {
      // Transport, database, and constraint failures are all reported as one
      // opaque availability error so no row content or SQL detail escapes.
      throw new SupabaseConversationRepositoryError(
        "SUPABASE_CONVERSATION_UNAVAILABLE",
      );
    }
  }
}

function parseDraft(record: unknown): PrivateDraft | null {
  // A lifecycle guard that refused the call returns SQL NULL, which is the
  // interface's documented `null`, not a persistence error. `undefined` is
  // an unparseable response body and stays an invalid-payload failure.
  if (record === null) return null;
  const parsed = privateDraftSchema.safeParse(record);
  if (!parsed.success) {
    throw new SupabaseConversationRepositoryError(
      "INVALID_SUPABASE_CONVERSATION_RECORD",
    );
  }
  return parsed.data;
}
