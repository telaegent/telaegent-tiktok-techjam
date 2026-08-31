import { z } from "zod";
import type { ProviderSessionScope } from "../provider-session-manager.js";
import type { RunPurpose } from "../runtime-contract.js";
import { SupabaseRpcTransport } from "../supabase-rpc-transport.js";
import { PROTOCOL_LIMITS } from "../telagent/protocol/contract.js";
import type {
  DurableContextLoader,
  DurableConversationContext,
} from "../telagent/protocol/runtime-adapter.js";

const sharedContextFields = {
  facts: z.strictObject({
    repositoryFullName: z.string().min(3).max(140),
    githubRepositoryId: z.string().regex(/^[1-9][0-9]{0,18}$/),
    branch: z.string().min(1).max(255),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    ownerName: z.string().min(1).max(80),
    collaboratorName: z.string().min(1).max(80),
  }),
  sharedHistory: z.array(z.strictObject({
    id: z.string().uuid(),
    author: z.string().min(1).max(80),
    origin: z.literal("agent"),
    text: z.string().min(1).max(50_000),
    at: z.string().datetime({ offset: true }),
  })).max(200),
  projectFacts: z.array(z.string().min(1).max(512)).max(16),
  privateTurns: z.array(z.strictObject({
    speaker: z.enum(["owner", "agent"]),
    text: z.string().min(1).max(PROTOCOL_LIMITS.maxPrivateMessageChars),
  })).max(32),
} as const;

/**
 * Discriminated on `role`, so a recipient row can never satisfy the sender shape.
 * `ownerInput` and `incomingMessage` are mutually exclusive by construction: the
 * strict objects reject the other role's input field outright.
 */
const contextSchema = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.literal("sender"),
    ...sharedContextFields,
    ownerInput: z.string().min(1).max(PROTOCOL_LIMITS.maxPrivateMessageChars),
  }),
  z.strictObject({
    role: z.literal("recipient"),
    ...sharedContextFields,
    // Authored by another person's agent and already across the trust boundary.
    // Bounded by the approved-message limit, not the private-message limit.
    incomingMessage: z.string().min(1).max(50_000),
  }),
]);

/** The RPC that reconstructs each role's turn from durable rows alone. */
const CONTEXT_RPCS: Readonly<Record<string, string>> = Object.freeze({
  sender_draft: "load_sender_protocol_context",
  recipient_answer: "load_recipient_protocol_context",
});

/** Loads only Telaegent-owned durable rows needed to rebuild one private turn. */
export class SupabaseProtocolContextLoader {
  private readonly transport: SupabaseRpcTransport;

  constructor(
    supabaseUrl: string,
    secretKey: string,
    fetchImplementation?: typeof fetch,
  ) {
    this.transport = new SupabaseRpcTransport({
      supabaseUrl,
      secretKey,
      maximumResponseBytes: 2_097_152,
      ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
    });
  }

  readonly load: DurableContextLoader = async (
    scope: ProviderSessionScope,
    request: Readonly<{ purpose: RunPurpose; correlationId: string }>,
  ): Promise<DurableConversationContext | null> => {
    const rpc = CONTEXT_RPCS[request.purpose];
    if (rpc === undefined) return null;
    const value = await this.transport.call(rpc, {
      p_user_id: scope.userId,
      p_github_repository_id: scope.githubRepositoryId,
      p_conversation_id: scope.conversationId,
      p_draft_id: request.correlationId,
      p_message_limit: 200,
    });
    if (value === null) return null;
    const parsed = contextSchema.safeParse(value);
    if (!parsed.success) throw new Error("Durable protocol context is invalid");
    return parsed.data;
  };
}
