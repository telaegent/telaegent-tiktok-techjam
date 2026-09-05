import type {
  OutboundApproval,
  PrivateDraft,
  PrivateDraftFailure,
  PrivateDraftState,
  SendDraftResult,
  SharedMessage,
} from "./types.js";

export interface CompleteDraftInput {
  draftId: string;
  expectedTurnId: string;
  state: Extract<PrivateDraftState, "needs_clarification" | "ready" | "blocked">;
  privateMessage: string;
  sendCandidate: string | null;
  riskFlags: PrivateDraft["riskFlags"];
  guardFindings: PrivateDraft["guardFindings"];
  updatedAt: string;
}

export interface SendDraftInput {
  draftId: string;
  ownerUserId: string;
  approvedBody: string;
  idempotencyKey: string;
  message: SharedMessage;
  approval: OutboundApproval;
  updatedAt: string;
}

export interface CreateRecipientDraftResult {
  draft: PrivateDraft;
  /** True when the same owner-scoped creation key replayed an existing draft. */
  replayed: boolean;
}

/**
 * Persistence boundary for the canonical messaging lifecycle.
 *
 * `sendDraft` must be one atomic transaction in durable adapters: approval,
 * shared-message append, and the draft's sent state either all commit or none
 * do. The in-memory adapter preserves the same observable contract.
 */
export interface ConversationRepository {
  createDraft(draft: PrivateDraft): Promise<PrivateDraft>;
  /**
   * Opens a private draft that answers an approved collaborator message.
   *
   * Returns `null` when `incomingMessageId` is not a message this owner may
   * answer in this scope -- absent, out of conversation, out of repository, or
   * authored by the owner themselves. That check belongs to the adapter because
   * it is a scope guard, not a product decision.
   */
  createRecipientDraft(input: Readonly<{
    draft: PrivateDraft;
    idempotencyKey: string;
  }>): Promise<CreateRecipientDraftResult | null>;
  getDraft(draftId: string): Promise<PrivateDraft | null>;
  markDraftRunning(input: {
    draftId: string;
    ownerUserId: string;
    turnId: string;
    updatedAt: string;
  }): Promise<PrivateDraft | null>;
  addOwnerClarification(input: {
    draftId: string;
    ownerUserId: string;
    content: string;
    updatedAt: string;
  }): Promise<PrivateDraft | null>;
  completeDraft(input: CompleteDraftInput): Promise<PrivateDraft | null>;
  markDraftFailed(input: {
    draftId: string;
    expectedTurnId: string;
    privateMessage: string;
    failure: PrivateDraftFailure;
    updatedAt: string;
  }): Promise<PrivateDraft | null>;
  cancelDraft(input: {
    draftId: string;
    ownerUserId: string;
    expectedTurnId?: string | undefined;
    updatedAt: string;
  }): Promise<PrivateDraft | null>;
  sendDraft(input: SendDraftInput): Promise<SendDraftResult | null>;
  listMessages(conversationId: string): Promise<SharedMessage[]>;
  /**
   * Fails every draft a lost runtime left running, returning how many moved.
   *
   * Draft state is durable and the runtime advancing it is not, so a restart
   * strands `agent_working` rows: they cannot run again (running requires
   * `created`) and cannot be cancelled (cancelling names a turn no coordinator
   * still tracks). Called once at startup, before the server accepts requests.
   */
  reconcileRunningDrafts(input: {
    privateMessage: string;
    failure: PrivateDraftFailure;
    updatedAt: string;
  }): Promise<number>;
}
