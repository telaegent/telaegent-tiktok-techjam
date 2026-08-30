import type {
  OutboundApproval,
  PrivateDraft,
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

/**
 * Persistence boundary for the canonical messaging lifecycle.
 *
 * `sendDraft` must be one atomic transaction in durable adapters: approval,
 * shared-message append, and the draft's sent state either all commit or none
 * do. The in-memory adapter preserves the same observable contract.
 */
export interface ConversationRepository {
  createDraft(draft: PrivateDraft): Promise<PrivateDraft>;
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
}
