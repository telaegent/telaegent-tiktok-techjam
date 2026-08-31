import { randomUUID } from "node:crypto";
import type { AuthorizePrivateRuntimeInput } from "../authorization/types.js";
import { HttpError } from "../errors.js";
import type { StartedPrivateRuntimeTurn } from "../private-runtime-turn-coordinator.js";
import type { AgentProvider } from "../runtime-contract.js";
import { normalizeRuntimeFailure, RuntimeProviderError } from "../runtime-errors.js";
import { redactText } from "../telagent/redaction.js";
import {
  PROTOCOL_LIMITS,
  type ProtocolRole,
  type ProtocolTurnOutput,
} from "../telagent/protocol/contract.js";
import { guardTurn, inspectCandidate, type GuardFinding } from "../telagent/protocol/guards.js";
import {
  recipientOutputSchema,
  senderOutputSchema,
} from "../telagent/protocol/schemas.js";
import type { StartAuthorizedProtocolTurnInput } from "../telagent/protocol/authorized-turn-service.js";
import type { ConversationRepository } from "./repository.js";
import {
  toPrivateDraftView,
  type PrivateDraft,
  type PrivateDraftView,
  type SendDraftResult,
  type SharedMessage,
} from "./types.js";

export type ConversationAction =
  | "read"
  | "create_draft"
  | "create_reply"
  | "clarify_draft"
  | "run_draft"
  | "send"
  | "cancel";

export interface ConversationAccessAuthorizer {
  authorize(input: Readonly<AuthorizePrivateRuntimeInput & { action: ConversationAction }>): Promise<void>;
}

export interface PrivateDraftTurnRuntime {
  start<T = unknown>(
    input: Readonly<StartAuthorizedProtocolTurnInput>,
  ): Promise<StartedPrivateRuntimeTurn<T>>;
  cancel(input: Readonly<{
    turnId: string;
    authenticatedUserId: string;
    githubRepositoryId: string;
    conversationId: string;
  }>): Promise<boolean>;
}

export class MessagePolicyError extends Error {
  constructor(public readonly findings: readonly GuardFinding[]) {
    super("Message blocked by policy");
    this.name = "MessagePolicyError";
  }
}

export interface ConversationServiceOptions {
  now?: (() => Date) | undefined;
  createId?: (() => string) | undefined;
}

export class ConversationService {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly repository: ConversationRepository,
    private readonly access: ConversationAccessAuthorizer,
    private readonly runtime: PrivateDraftTurnRuntime,
    options: ConversationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async createDraft(input: Readonly<{
    authenticatedUserId: string;
    githubRepositoryId: string;
    conversationId: string;
    provider: AgentProvider;
    roughMessage: string;
  }>): Promise<PrivateDraftView> {
    await this.authorize(input, "create_draft");
    const timestamp = this.now().toISOString();
    const draft: PrivateDraft = {
      draftId: this.createId(),
      conversationId: input.conversationId,
      githubRepositoryId: input.githubRepositoryId,
      ownerUserId: input.authenticatedUserId,
      provider: input.provider,
      role: "sender",
      roughMessage: input.roughMessage,
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
    return toPrivateDraftView(await this.repository.createDraft(draft));
  }

  /**
   * Opens a private draft that answers an approved collaborator message.
   *
   * This is the recipient half of the signature interaction. It is deliberately
   * a normal draft: the reply it produces is still owner-private until the owner
   * approves it, and still leaves through `sendDraft`, so a reply crosses the
   * trust boundary under exactly the same human gate as any other message.
   */
  async createRecipientDraft(input: Readonly<{
    authenticatedUserId: string;
    githubRepositoryId: string;
    conversationId: string;
    provider: AgentProvider;
    incomingMessageId: string;
    ownerGuidance?: string | undefined;
  }>): Promise<PrivateDraftView> {
    await this.authorize(input, "create_reply");
    const timestamp = this.now().toISOString();
    const draft: PrivateDraft = {
      draftId: this.createId(),
      conversationId: input.conversationId,
      githubRepositoryId: input.githubRepositoryId,
      ownerUserId: input.authenticatedUserId,
      provider: input.provider,
      role: "recipient",
      roughMessage: input.ownerGuidance ?? null,
      incomingMessageId: input.incomingMessageId,
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
    const created = await this.repository.createRecipientDraft(draft);
    if (!created) throw new HttpError(409, "Message cannot be replied to");
    return toPrivateDraftView(created);
  }

  async getDraft(authenticatedUserId: string, draftId: string): Promise<PrivateDraftView> {
    const draft = await this.ownedDraft(authenticatedUserId, draftId);
    await this.authorizeDraft(draft, "read");
    return toPrivateDraftView(draft);
  }

  async runDraft(authenticatedUserId: string, draftId: string): Promise<PrivateDraftView> {
    const draft = await this.ownedDraft(authenticatedUserId, draftId);
    if (draft.state !== "created") throw new HttpError(409, "Private draft cannot be run");
    await this.authorizeDraft(draft, "run_draft");

    const started = await this.runtime.start<ProtocolTurnOutput>({
      authorization: this.authorizationInput(draft),
      provider: draft.provider,
      role: draft.role,
      correlationId: draft.draftId,
    });
    const running = await this.repository.markDraftRunning({
      draftId: draft.draftId,
      ownerUserId: authenticatedUserId,
      turnId: started.turnId,
      updatedAt: this.now().toISOString(),
    });
    if (!running) throw new HttpError(409, "Private draft cannot be run");

    void this.settleTurn(draft.draftId, draft.role, started.turnId, started.completion);
    return toPrivateDraftView(running);
  }

  async addClarification(input: Readonly<{
    authenticatedUserId: string;
    draftId: string;
    content: string;
  }>): Promise<PrivateDraftView> {
    const draft = await this.ownedDraft(input.authenticatedUserId, input.draftId);
    if (draft.state !== "needs_clarification") {
      throw new HttpError(409, "Private draft is not waiting for clarification");
    }
    const ownerTurns = draft.privateTurns.filter((turn) => turn.speaker === "owner").length;
    if (ownerTurns >= PROTOCOL_LIMITS.maxClarificationTurns) {
      throw new HttpError(409, "Private draft clarification limit reached");
    }
    await this.authorizeDraft(draft, "clarify_draft");
    const updated = await this.repository.addOwnerClarification({
      draftId: draft.draftId,
      ownerUserId: input.authenticatedUserId,
      content: input.content,
      updatedAt: this.now().toISOString(),
    });
    if (!updated) throw new HttpError(409, "Private draft cannot accept clarification");
    return toPrivateDraftView(updated);
  }

  async cancelDraft(authenticatedUserId: string, draftId: string): Promise<PrivateDraftView> {
    const draft = await this.ownedDraft(authenticatedUserId, draftId);
    await this.authorizeDraft(draft, "cancel");
    if (draft.state === "sent") throw new HttpError(409, "Sent messages cannot be cancelled");

    if (draft.state === "agent_working") {
      if (!draft.turnId) throw new HttpError(409, "Private draft cannot be cancelled");
      const cancelled = await this.runtime.cancel({
        turnId: draft.turnId,
        authenticatedUserId,
        githubRepositoryId: draft.githubRepositoryId,
        conversationId: draft.conversationId,
      });
      if (!cancelled) throw new HttpError(409, "Private draft cannot be cancelled");
    }

    const updated = await this.repository.cancelDraft({
      draftId,
      ownerUserId: authenticatedUserId,
      ...(draft.turnId ? { expectedTurnId: draft.turnId } : {}),
      updatedAt: this.now().toISOString(),
    });
    if (!updated) throw new HttpError(409, "Private draft cannot be cancelled");
    return toPrivateDraftView(updated);
  }

  async sendDraft(input: Readonly<{
    authenticatedUserId: string;
    draftId: string;
    approvedContent?: string | undefined;
    idempotencyKey: string;
  }>): Promise<SendDraftResult> {
    const draft = await this.ownedDraft(input.authenticatedUserId, input.draftId);
    if (draft.state !== "ready" && draft.state !== "sent") {
      throw new HttpError(409, "Private draft is not ready to send");
    }
    await this.authorizeDraft(draft, "send");
    const approvedBody = (input.approvedContent ?? draft.sendCandidate ?? "").trim();
    const verdict = inspectCandidate(approvedBody);
    if (!verdict.sendable) throw new MessagePolicyError(verdict.findings);

    const timestamp = this.now().toISOString();
    const messageId = this.createId();
    const approvalId = this.createId();
    const result = await this.repository.sendDraft({
      draftId: draft.draftId,
      ownerUserId: input.authenticatedUserId,
      approvedBody,
      idempotencyKey: input.idempotencyKey,
      message: {
        messageId,
        conversationId: draft.conversationId,
        githubRepositoryId: draft.githubRepositoryId,
        senderUserId: input.authenticatedUserId,
        body: approvedBody,
        origin: "agent",
        provider: draft.provider,
        sentAt: timestamp,
      },
      approval: {
        approvalId,
        draftId: draft.draftId,
        messageId,
        actorUserId: input.authenticatedUserId,
        approvedBody,
        idempotencyKey: input.idempotencyKey,
        approvedAt: timestamp,
      },
      updatedAt: timestamp,
    });
    if (!result) throw new HttpError(409, "Send request conflicts with existing state");
    return result;
  }

  async listMessages(input: Readonly<{
    authenticatedUserId: string;
    githubRepositoryId: string;
    conversationId: string;
  }>): Promise<SharedMessage[]> {
    await this.authorize(input, "read");
    return this.repository.listMessages(input.conversationId);
  }

  private async completeTurn(
    draftId: string,
    role: ProtocolRole,
    turnId: string,
    rawOutput: unknown,
  ): Promise<void> {
    const parsed =
      role === "sender"
        ? senderOutputSchema.safeParse(rawOutput)
        : recipientOutputSchema.safeParse(rawOutput);
    if (!parsed.success) {
      return this.failTurn(
        draftId,
        turnId,
        new RuntimeProviderError("INVALID_AGENT_OUTPUT", "Invalid structured output"),
      );
    }
    const output = parsed.data;
    const guarded = guardTurn(output);
    // Both roles carry one owner-visible private message; only the field name
    // differs. Neither is ever transmitted to the collaborator.
    const privateMessage = redactText(
      "assistantMessage" in output ? output.assistantMessage : output.privateSummary,
    ).value;
    await this.repository.completeDraft({
      draftId,
      expectedTurnId: turnId,
      state: guarded.effectiveState,
      privateMessage,
      sendCandidate:
        guarded.effectiveState === "ready" ? guarded.verdict.redactedCandidate : null,
      riskFlags: guarded.verdict.effectiveFlags,
      guardFindings: guarded.verdict.findings,
      updatedAt: this.now().toISOString(),
    });
  }

  private async settleTurn(
    draftId: string,
    role: ProtocolRole,
    turnId: string,
    completion: StartedPrivateRuntimeTurn<ProtocolTurnOutput>["completion"],
  ): Promise<void> {
    try {
      const result = await completion;
      await this.completeTurn(draftId, role, turnId, result.final);
    } catch (error) {
      // Runtime and persistence failures are deliberately collapsed to one safe
      // owner-facing state. Raw provider/database errors never enter the draft.
      try {
        await this.failTurn(draftId, turnId, error);
      } catch {
        // The HTTP request has already returned 202. A durable adapter reports
        // this through its own safe audit/alerting path; never create an
        // unhandled rejection containing infrastructure details.
      }
    }
  }

  private async failTurn(draftId: string, turnId: string, error: unknown): Promise<void> {
    const failure = normalizeRuntimeFailure(error);
    await this.repository.markDraftFailed({
      draftId,
      expectedTurnId: turnId,
      privateMessage: failure.message,
      failure: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
      updatedAt: this.now().toISOString(),
    });
  }

  private async ownedDraft(authenticatedUserId: string, draftId: string): Promise<PrivateDraft> {
    const draft = await this.repository.getDraft(draftId);
    if (!draft || draft.ownerUserId !== authenticatedUserId) {
      throw new HttpError(404, "Private draft not found");
    }
    return draft;
  }

  private authorizeDraft(draft: Readonly<PrivateDraft>, action: ConversationAction): Promise<void> {
    return this.authorize(
      {
        authenticatedUserId: draft.ownerUserId,
        githubRepositoryId: draft.githubRepositoryId,
        conversationId: draft.conversationId,
      },
      action,
    );
  }

  private authorize(
    input: Readonly<AuthorizePrivateRuntimeInput>,
    action: ConversationAction,
  ): Promise<void> {
    return this.access.authorize({ ...input, action });
  }

  private authorizationInput(draft: Readonly<PrivateDraft>): AuthorizePrivateRuntimeInput {
    return {
      authenticatedUserId: draft.ownerUserId,
      githubRepositoryId: draft.githubRepositoryId,
      conversationId: draft.conversationId,
    };
  }
}
