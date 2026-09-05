import type {
  CompleteDraftInput,
  ConversationRepository,
  CreateRecipientDraftResult,
  SendDraftInput,
} from "./repository.js";
import type {
  OutboundApproval,
  PrivateDraft,
  PrivateDraftFailure,
  SendDraftResult,
  SharedMessage,
} from "./types.js";

const cloneDraft = (draft: PrivateDraft): PrivateDraft => structuredClone(draft);
const sendKey = (ownerUserId: string, idempotencyKey: string): string =>
  ownerUserId + "\u0000" + idempotencyKey;

export class InMemoryConversationRepository implements ConversationRepository {
  private readonly drafts = new Map<string, PrivateDraft>();
  private readonly messages = new Map<string, SharedMessage>();
  private readonly approvals = new Map<string, OutboundApproval>();
  private readonly sendsByKey = new Map<string, { messageId: string; approvalId: string }>();
  private readonly recipientDraftsByKey = new Map<string, string>();

  async createDraft(draft: PrivateDraft): Promise<PrivateDraft> {
    if (this.drafts.has(draft.draftId)) throw new Error("Duplicate private draft ID");
    this.drafts.set(draft.draftId, cloneDraft(draft));
    return cloneDraft(draft);
  }

  async createRecipientDraft(input: Readonly<{
    draft: PrivateDraft;
    idempotencyKey: string;
  }>): Promise<CreateRecipientDraftResult | null> {
    const { draft } = input;
    const key = sendKey(draft.ownerUserId, input.idempotencyKey);
    const replayedDraftId = this.recipientDraftsByKey.get(key);
    if (replayedDraftId) {
      const replayed = this.drafts.get(replayedDraftId);
      if (
        !replayed ||
        replayed.role !== "recipient" ||
        replayed.conversationId !== draft.conversationId ||
        replayed.githubRepositoryId !== draft.githubRepositoryId ||
        replayed.provider !== draft.provider ||
        replayed.incomingMessageId !== draft.incomingMessageId ||
        replayed.roughMessage !== draft.roughMessage
      ) {
        return null;
      }
      return { draft: cloneDraft(replayed), replayed: true };
    }
    if (this.drafts.has(draft.draftId)) throw new Error("Duplicate private draft ID");
    if (draft.incomingMessageId === null) return null;
    const incoming = this.messages.get(draft.incomingMessageId);
    // Mirrors the scope guard in create_recipient_draft: an owner answers a
    // collaborator's message in this conversation and repository, never their own.
    if (
      !incoming ||
      incoming.conversationId !== draft.conversationId ||
      incoming.githubRepositoryId !== draft.githubRepositoryId ||
      incoming.senderUserId === draft.ownerUserId
    ) {
      return null;
    }
    this.drafts.set(draft.draftId, cloneDraft(draft));
    this.recipientDraftsByKey.set(key, draft.draftId);
    return { draft: cloneDraft(draft), replayed: false };
  }

  async getDraft(draftId: string): Promise<PrivateDraft | null> {
    const draft = this.drafts.get(draftId);
    return draft ? cloneDraft(draft) : null;
  }

  async markDraftRunning(input: {
    draftId: string;
    ownerUserId: string;
    turnId: string;
    updatedAt: string;
  }): Promise<PrivateDraft | null> {
    const draft = this.drafts.get(input.draftId);
    if (!draft || draft.ownerUserId !== input.ownerUserId || draft.state !== "created") {
      return null;
    }
    draft.state = "agent_working";
    draft.turnId = input.turnId;
    draft.failure = null;
    draft.updatedAt = input.updatedAt;
    return cloneDraft(draft);
  }

  async completeDraft(input: CompleteDraftInput): Promise<PrivateDraft | null> {
    const draft = this.drafts.get(input.draftId);
    if (
      !draft ||
      draft.state !== "agent_working" ||
      draft.turnId !== input.expectedTurnId
    ) {
      return null;
    }
    draft.state = input.state;
    draft.privateMessage = input.privateMessage;
    draft.sendCandidate = input.sendCandidate;
    draft.riskFlags = [...input.riskFlags];
    draft.guardFindings = structuredClone(input.guardFindings);
    draft.failure = null;
    if (input.state === "needs_clarification") {
      draft.privateTurns.push({ speaker: "agent", text: input.privateMessage });
    }
    draft.updatedAt = input.updatedAt;
    return cloneDraft(draft);
  }

  async addOwnerClarification(input: {
    draftId: string;
    ownerUserId: string;
    content: string;
    updatedAt: string;
  }): Promise<PrivateDraft | null> {
    const draft = this.drafts.get(input.draftId);
    if (
      !draft ||
      draft.ownerUserId !== input.ownerUserId ||
      draft.state !== "needs_clarification"
    ) {
      return null;
    }
    draft.privateTurns.push({ speaker: "owner", text: input.content });
    draft.state = "created";
    draft.turnId = null;
    draft.privateMessage = null;
    draft.sendCandidate = null;
    draft.riskFlags = [];
    draft.guardFindings = [];
    draft.failure = null;
    draft.updatedAt = input.updatedAt;
    return cloneDraft(draft);
  }

  async markDraftFailed(input: {
    draftId: string;
    expectedTurnId: string;
    privateMessage: string;
    failure: PrivateDraftFailure;
    updatedAt: string;
  }): Promise<PrivateDraft | null> {
    const draft = this.drafts.get(input.draftId);
    if (
      !draft ||
      draft.state !== "agent_working" ||
      draft.turnId !== input.expectedTurnId
    ) {
      return null;
    }
    draft.state = "runtime_failed";
    draft.privateMessage = input.privateMessage;
    draft.failure = { ...input.failure };
    draft.sendCandidate = null;
    draft.updatedAt = input.updatedAt;
    return cloneDraft(draft);
  }

  async cancelDraft(input: {
    draftId: string;
    ownerUserId: string;
    expectedTurnId?: string | undefined;
    updatedAt: string;
  }): Promise<PrivateDraft | null> {
    const draft = this.drafts.get(input.draftId);
    if (!draft || draft.ownerUserId !== input.ownerUserId) return null;
    if (draft.state === "sent" || draft.state === "cancelled") return cloneDraft(draft);
    if (
      draft.state === "agent_working" &&
      (!input.expectedTurnId || draft.turnId !== input.expectedTurnId)
    ) {
      return null;
    }
    draft.state = "cancelled";
    draft.sendCandidate = null;
    draft.updatedAt = input.updatedAt;
    return cloneDraft(draft);
  }

  async sendDraft(input: SendDraftInput): Promise<SendDraftResult | null> {
    const key = sendKey(input.ownerUserId, input.idempotencyKey);
    const replay = this.sendsByKey.get(key);
    if (replay) {
      const message = this.messages.get(replay.messageId);
      const approval = this.approvals.get(replay.approvalId);
      if (
        !message ||
        !approval ||
        approval.draftId !== input.draftId ||
        approval.approvedBody !== input.approvedBody
      ) {
        return null;
      }
      return {
        message: structuredClone(message),
        approval: structuredClone(approval),
        replayed: true,
      };
    }

    const draft = this.drafts.get(input.draftId);
    if (
      !draft ||
      draft.ownerUserId !== input.ownerUserId ||
      draft.state !== "ready" ||
      draft.sendCandidate === null
    ) {
      return null;
    }

    this.messages.set(input.message.messageId, structuredClone(input.message));
    this.approvals.set(input.approval.approvalId, structuredClone(input.approval));
    this.sendsByKey.set(key, {
      messageId: input.message.messageId,
      approvalId: input.approval.approvalId,
    });
    draft.state = "sent";
    draft.sendCandidate = input.approvedBody;
    draft.sentMessageId = input.message.messageId;
    draft.updatedAt = input.updatedAt;
    return {
      message: structuredClone(input.message),
      approval: structuredClone(input.approval),
      replayed: false,
    };
  }

  async listMessages(conversationId: string): Promise<SharedMessage[]> {
    return [...this.messages.values()]
      .filter((message) => message.conversationId === conversationId)
      .sort((left, right) => left.sentAt.localeCompare(right.sentAt))
      .map((message) => structuredClone(message));
  }

  async reconcileRunningDrafts(input: {
    privateMessage: string;
    failure: PrivateDraftFailure;
    updatedAt: string;
  }): Promise<number> {
    let reconciled = 0;
    for (const draft of this.drafts.values()) {
      if (draft.state !== "agent_working") continue;
      draft.state = "runtime_failed";
      draft.privateMessage = input.privateMessage;
      draft.failure = structuredClone(input.failure);
      // A candidate from a turn that never finished was never approved.
      draft.sendCandidate = null;
      draft.updatedAt = input.updatedAt;
      reconciled += 1;
    }
    return reconciled;
  }
}
