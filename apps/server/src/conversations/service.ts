import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthorizePrivateRuntimeInput } from "../authorization/types.js";
import type { PrivateDraftFollowUp } from "../capability/draft-follow-up.js";
import { HttpError, RunCancelledError } from "../errors.js";
import type { StartedPrivateRuntimeTurn } from "../private-runtime-turn-coordinator.js";
import type { AgentProvider } from "../runtime-contract.js";
import { normalizeRuntimeFailure, RuntimeProviderError } from "../runtime-errors.js";
import type { RuntimeEffort } from "../runtime-efforts.js";
import { isSupportedModel } from "../runtime-models.js";
import { redactText } from "../telagent/redaction.js";
import {
  PROTOCOL_LIMITS,
  type ProtocolRole,
  type ProtocolTurnOutput,
} from "../telagent/protocol/contract.js";
import { guardTurn, inspectCandidate, type GuardFinding } from "../telagent/protocol/guards.js";
import {
  normalizeRecipientOutput,
  recipientOutputSchema,
  senderOutputSchema,
  withoutNullOptionals,
} from "../telagent/protocol/schemas.js";
import type { StartAuthorizedProtocolTurnInput } from "../telagent/protocol/authorized-turn-service.js";
import type { ConversationRepository } from "./repository.js";
import type { AgentClarificationCoordinator } from "../agent-clarification/coordinator.js";
import { MAX_AGENT_CLARIFICATION_QUESTIONS } from "../agent-clarification/contract.js";
import type { AgentClarificationTask } from "../agent-clarification/repository.js";
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

/**
 * What the owner picked for one run.
 *
 * Both fields are optional and independent, and absent means "do not choose" --
 * which is what every client sent before the pickers existed, and what a run
 * triggered by anything other than the owner's own screen still sends.
 */
export interface PrivateRunChoice {
  model?: string | undefined;
  effort?: RuntimeEffort | undefined;
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
  createTurnId?: (() => string) | undefined;
  /**
   * Carries a turn's questions to the other person's machine (build plan 8).
   *
   * Absent by default. Without it a turn that asked for files simply answers
   * with what it already had, which is what every deployment did before the
   * capability loop existed.
   */
  followUp?: PrivateDraftFollowUp | undefined;
  /** Default-absent rollout seam for bilateral task clarification. */
  agentClarification?: AgentClarificationCoordinator | undefined;
}

/**
 * Build plan 8.7. The database holds the same bound on the task itself; this is
 * the in-process copy, so a runtime that never reached the database still stops.
 */
const MAX_FOLLOW_UP_ROUNDS = 5;

/** Largest transcript page one read may return. */
export const MAX_TRANSCRIPT_PAGE_SIZE = 200;
export const MAX_RECOVERABLE_DRAFTS = 50;

export interface SharedMessageListPage {
  messages: SharedMessage[];
  nextCursor: string | null;
  /** Cursor after the last returned message, including on the final page. */
  pollCursor: string | null;
}

const transcriptCursorPayload = z.strictObject({
  version: z.literal(1),
  sentAt: z.string().datetime(),
  messageId: z.string().uuid(),
});
const transcriptCursorPattern = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Cursors are opaque to the browser and validated on the way back in.
 *
 * A client cannot widen its own read with one: the cursor names a position in
 * an ordering, and the conversation and the caller's authorization are settled
 * before it is ever consulted.
 */
function decodeTranscriptCursor(
  value: string | undefined,
): { sentAt: string; messageId: string } | null {
  if (value === undefined) return null;
  if (!transcriptCursorPattern.test(value)) throw invalidTranscriptCursor();
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value || bytes.byteLength > 192) {
      throw invalidTranscriptCursor();
    }
    const parsed = transcriptCursorPayload.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    return { sentAt: parsed.sentAt, messageId: parsed.messageId };
  } catch {
    throw invalidTranscriptCursor();
  }
}

function encodeTranscriptCursor(sentAt: string, messageId: string): string {
  return Buffer.from(
    JSON.stringify({ version: 1, sentAt, messageId }),
    "utf8",
  ).toString("base64url");
}

function invalidTranscriptCursor(): z.ZodError {
  return new z.ZodError([
    { code: "custom", path: ["cursor"], message: "Invalid transcript cursor" },
  ]);
}

export class ConversationService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly createTurnId: () => string;
  private readonly followUp: PrivateDraftFollowUp | undefined;
  private readonly agentClarification: AgentClarificationCoordinator | undefined;
  /**
   * Draft ID to the runtime turn currently executing for it.
   *
   * The draft keeps the turn identifier it claimed when it started running, so
   * an owner still sees one turn. Each follow-up round is a separate runtime
   * turn with its own identifier, and cancelling has to reach the round that is
   * actually running: cancelling the first round's identifier once round two
   * has begun stops nothing, because the coordinator no longer tracks it as
   * running. This map is process-local, matching the coordinator it addresses.
   */
  private readonly activeRuntimeTurns = new Map<string, string | null>();
  /** Cancels a draft while it is paused at the durable human approval gate. */
  private readonly followUpWaits = new Map<string, AbortController>();
  /** Drafts cancelled while moving between runtime rounds. */
  private readonly cancellationRequested = new Set<string>();

  constructor(
    private readonly repository: ConversationRepository,
    private readonly access: ConversationAccessAuthorizer,
    private readonly runtime: PrivateDraftTurnRuntime,
    options: ConversationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.createTurnId = options.createTurnId ?? randomUUID;
    this.followUp = options.followUp;
    this.agentClarification = options.agentClarification;
  }

  /**
   * Recovers drafts a lost runtime left running. Call once, before serving.
   *
   * Draft state is durable and everything that advances it is not: the turn
   * coordinator's map, the connector relay's registrations and the in-flight
   * completion all die with the process, while `agent_working` rows survive. A
   * draft in that state is unreachable through the normal API -- running
   * requires `created`, and cancelling has to name a turn no coordinator still
   * tracks -- so without this the owner watches an agent work on it forever.
   *
   * This ends the forever-spinner and lets the owner reject the draft to clear
   * it. It does not make the draft runnable again: running requires state
   * `created`, so a reconciled draft cannot be re-run, and the browser's Retry
   * rebuilds from React state a reload has already emptied. Resuming the
   * original draft needs a change to the run guard and to Retry, which is not
   * claimed here -- so the owner-facing message asks for a new draft, which is
   * a thing they can actually do.
   */
  async reconcileRunningDrafts(): Promise<number> {
    return this.repository.reconcileRunningDrafts({
      privateMessage:
        "This draft stopped because the server restarted while its agent was working. Nothing was sent. Start a new draft to ask again.",
      failure: {
        // The runtime that was working on this draft no longer exists, which
        // is exactly what this code means.
        code: "RUNTIME_UNAVAILABLE",
        message: "Server restarted while this draft's agent was working",
        // Not retryable, because this draft cannot be re-run: the run guard
        // requires state `created`. The browser renders Retry on any failure
        // that is not explicitly false, and a Retry that issues no request and
        // reports no error is worse than no button at all. The message tells
        // the owner to start a new draft, which does work.
        retryable: false,
      },
      updatedAt: this.now().toISOString(),
    });
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
    const roughMessage = redactPrivateInput(input.roughMessage);
    const draft: PrivateDraft = {
      draftId: this.createId(),
      conversationId: input.conversationId,
      githubRepositoryId: input.githubRepositoryId,
      ownerUserId: input.authenticatedUserId,
      provider: input.provider,
      role: "sender",
      roughMessage,
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
    idempotencyKey: string;
    allowAgentClarification?: boolean | undefined;
    dialogueModel?: string | undefined;
  }>): Promise<Readonly<{ draft: PrivateDraftView; replayed: boolean }>> {
    await this.authorize(input, "create_reply");
    const timestamp = this.now().toISOString();
    const ownerGuidance = input.ownerGuidance
      ? redactPrivateInput(input.ownerGuidance)
      : null;
    const draft: PrivateDraft = {
      draftId: this.createId(),
      conversationId: input.conversationId,
      githubRepositoryId: input.githubRepositoryId,
      ownerUserId: input.authenticatedUserId,
      provider: input.provider,
      role: "recipient",
      roughMessage: ownerGuidance,
      incomingMessageId: input.incomingMessageId,
      privateTurns: ownerGuidance
        ? [{ speaker: "owner", text: ownerGuidance }]
        : [],
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
    const created = await this.repository.createRecipientDraft({
      draft,
      idempotencyKey: input.idempotencyKey,
    });
    if (!created) throw new HttpError(409, "Message cannot be replied to");
    if (
      input.allowAgentClarification &&
      this.agentClarification &&
      (input.dialogueModel === undefined ||
        isSupportedModel(input.provider, input.dialogueModel))
    ) {
      // Consent persistence is fail-closed. The private draft remains usable
      // if the optional dialogue store is unavailable; no question crosses.
      await this.agentClarification.activateForRecipient(
        draftContext(created.draft),
        {
          provider: input.provider,
          ...(input.dialogueModel ? { model: input.dialogueModel } : {}),
        },
      ).catch(() => null);
    }
    return { draft: toPrivateDraftView(created.draft), replayed: created.replayed };
  }

  async getDraft(authenticatedUserId: string, draftId: string): Promise<PrivateDraftView> {
    const draft = await this.ownedDraft(authenticatedUserId, draftId);
    await this.authorizeDraft(draft, "read");
    return toPrivateDraftView(draft);
  }

  /** Reopens unfinished owner-private work after navigation or browser reload. */
  async listRecoverableDrafts(input: Readonly<{
    authenticatedUserId: string;
    githubRepositoryId: string;
    conversationId: string;
  }>): Promise<PrivateDraftView[]> {
    await this.authorize(input, "read");
    const drafts = await this.repository.listRecoverableDrafts({
      ownerUserId: input.authenticatedUserId,
      githubRepositoryId: input.githubRepositoryId,
      conversationId: input.conversationId,
      limit: MAX_RECOVERABLE_DRAFTS,
    });
    // Treat persistence as untrusted even after its owner filter. A bad adapter
    // must not turn the recovery endpoint into another user's private inbox.
    if (
      drafts.some(
        (draft) =>
          draft.ownerUserId !== input.authenticatedUserId ||
          draft.githubRepositoryId !== input.githubRepositoryId ||
          draft.conversationId !== input.conversationId ||
          draft.state === "sent" ||
          draft.state === "cancelled",
      )
    ) {
      throw new HttpError(503, "Private draft recovery is temporarily unavailable");
    }
    return drafts.slice(0, MAX_RECOVERABLE_DRAFTS).map(toPrivateDraftView);
  }

  /**
   * Starts a run, optionally on a model and an effort the owner picked for it.
   *
   * The choice belongs to the run rather than to the draft. It is not
   * persisted, so a draft resumed after a restart runs on the deployment
   * default again -- acceptable because every trigger comes from a UI that
   * already has the pickers' current values, and the alternative is changing a
   * SQL function's signature to store a preference the caller re-sends anyway.
   * Clarification is the same story: it returns the draft to `created` and the
   * owner runs it again, choosing again.
   */
  async runDraft(
    authenticatedUserId: string,
    draftId: string,
    choice: Readonly<PrivateRunChoice> = {},
  ): Promise<PrivateDraftView> {
    const { model, effort } = choice;
    const draft = await this.ownedDraft(authenticatedUserId, draftId);
    if (draft.state !== "created") throw new HttpError(409, "Private draft cannot be run");
    // Which models exist depends on the provider, and the provider is on the
    // draft rather than in the request body -- so this cannot be a schema check
    // at the edge. Rejecting here is what turns a bad pick into a 400 instead
    // of a turn that dies on a connector minutes later.
    if (model !== undefined && !isSupportedModel(draft.provider, model)) {
      throw new HttpError(400, "Requested model is not available for this provider");
    }
    // Effort has no matching check because it does not need one here: the
    // rungs are the same on every provider, so the route schema rejects a bad
    // one before this method is reached and the type says so. The authorization
    // seam re-checks it anyway, where the input is untyped.
    await this.authorizeDraft(draft, "run_draft");

    const clarificationTask =
      draft.role === "recipient" && this.agentClarification
        ? await this.agentClarification.loadForRecipient(draftContext(draft)).catch(() => null)
        : null;

    const turnId = this.createTurnId();
    const running = await this.repository.markDraftRunning({
      draftId: draft.draftId,
      ownerUserId: authenticatedUserId,
      turnId,
      updatedAt: this.now().toISOString(),
    });
    if (!running) throw new HttpError(409, "Private draft cannot be run");

    // `null` means the draft owns an execution lifecycle but is currently
    // authorizing/starting a round. It lets Cancel distinguish that safe gap
    // from a running draft stranded by a previous process.
    this.activeRuntimeTurns.set(draft.draftId, null);
    let started: StartedPrivateRuntimeTurn<ProtocolTurnOutput>;
    try {
      started = await this.runtime.start<ProtocolTurnOutput>({
        authorization: this.authorizationInput(draft),
        provider: draft.provider,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        role: draft.role,
        correlationId: draft.draftId,
        turnId,
        ...(this.taskSessionReady(clarificationTask, draft)
          ? {
              allowPeerClarification:
                clarificationTask.questionsUsed < MAX_AGENT_CLARIFICATION_QUESTIONS,
              taskSession: {
                taskId: clarificationTask.taskId,
                peerUserId: clarificationTask.requesterUserId,
                participantRole: "responder" as const,
                lane: "private_work" as const,
              },
            }
          : {}),
      });
    } catch (error) {
      this.activeRuntimeTurns.delete(draft.draftId);
      this.cancellationRequested.delete(draft.draftId);
      await this.failTurn(draft.draftId, turnId, error);
      throw error;
    }
    if (started.turnId !== turnId) {
      await this.runtime.cancel({
        turnId: started.turnId,
        authenticatedUserId,
        githubRepositoryId: draft.githubRepositoryId,
        conversationId: draft.conversationId,
      }).catch(() => false);
      const error = new RuntimeProviderError(
        "INVALID_AGENT_OUTPUT",
        "Private runtime returned an unexpected turn identifier",
      );
      this.activeRuntimeTurns.delete(draft.draftId);
      this.cancellationRequested.delete(draft.draftId);
      await this.failTurn(draft.draftId, turnId, error);
      throw error;
    }

    this.activeRuntimeTurns.set(draft.draftId, turnId);
    if (this.cancellationRequested.has(draft.draftId)) {
      await this.runtime.cancel({
        turnId,
        authenticatedUserId,
        githubRepositoryId: draft.githubRepositoryId,
        conversationId: draft.conversationId,
      }).catch(() => false);
    }
    void this.settleTurn(
      draft,
      turnId,
      started.completion,
      choice,
      clarificationTask,
    );
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
      content: redactPrivateInput(input.content),
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
      const ownsExecution = this.activeRuntimeTurns.has(draftId);
      if (ownsExecution) this.cancellationRequested.add(draftId);
      this.followUpWaits.get(draftId)?.abort(new RunCancelledError());
      // The round that is running now, which is the first turn until a
      // follow-up round replaces it.
      const runtimeTurnId = ownsExecution
        ? this.activeRuntimeTurns.get(draftId)
        : draft.turnId;
      if (runtimeTurnId) {
        const cancelled = await this.runtime.cancel({
          turnId: runtimeTurnId,
          authenticatedUserId,
          githubRepositoryId: draft.githubRepositoryId,
          conversationId: draft.conversationId,
        });
        // A completion can race this call. If settling moved the lifecycle into
        // its between-round gap, there is no provider left to cancel and the
        // cancellation flag prevents another one from starting.
        if (!cancelled && this.activeRuntimeTurns.get(draftId) === runtimeTurnId) {
          throw new HttpError(409, "Private draft cannot be cancelled");
        }
      } else if (!ownsExecution) {
        // No process-local owner means this is a stranded durable draft. The
        // startup reconciler normally removes this state; fail closed if it is
        // observed before reconciliation rather than pretending work stopped.
        throw new HttpError(409, "Private draft cannot be cancelled");
      }
    }

    const updated = await this.repository.cancelDraft({
      draftId,
      ownerUserId: authenticatedUserId,
      ...(draft.turnId ? { expectedTurnId: draft.turnId } : {}),
      updatedAt: this.now().toISOString(),
    });
    if (!updated) throw new HttpError(409, "Private draft cannot be cancelled");
    await this.endAgentClarification(updated, "cancelled");
    await this.endFollowUp(updated, "cancelled");
    return toPrivateDraftView(updated);
  }

  async sendDraft(input: Readonly<{
    authenticatedUserId: string;
    draftId: string;
    approvedContent?: string | undefined;
    idempotencyKey: string;
    allowAgentClarification?: boolean | undefined;
    dialogueModel?: string | undefined;
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
    if (
      input.allowAgentClarification &&
      this.agentClarification &&
      (input.dialogueModel === undefined ||
        isSupportedModel(draft.provider, input.dialogueModel))
    ) {
      // The shared message is already committed. A consent write may safely
      // fail closed, but may never roll back or duplicate the Send.
      await this.agentClarification.grantOriginator({
        originSharedMessageId: result.message.messageId,
        actorUserId: input.authenticatedUserId,
        choice: {
          provider: draft.provider,
          ...(input.dialogueModel ? { model: input.dialogueModel } : {}),
        },
      }).catch(() => false);
    }
    await this.endAgentClarification(draft, "completed");
    await this.endFollowUp(draft, "completed");
    return result;
  }

  /**
   * One page of a conversation transcript, oldest first.
   *
   * Paginated because an established conversation outgrows any single read.
   * The unpaginated reader raised CONVERSATION_TRANSCRIPT_TOO_LARGE past its
   * ceiling, which made a busy conversation permanently unreadable rather than
   * merely slow. Keyset ordering on `(sentAt, messageId)` keeps a transcript
   * that is still being written correct across pages.
   */
  async listMessages(input: Readonly<{
    authenticatedUserId: string;
    githubRepositoryId: string;
    conversationId: string;
    limit?: number | undefined;
    cursor?: string | undefined;
  }>): Promise<SharedMessageListPage> {
    await this.authorize(input, "read");
    const limit = z
      .number()
      .int()
      .min(1)
      .max(MAX_TRANSCRIPT_PAGE_SIZE)
      .parse(input.limit ?? MAX_TRANSCRIPT_PAGE_SIZE);
    const after = decodeTranscriptCursor(input.cursor);
    const rows = await this.repository.listMessagePage({
      conversationId: input.conversationId,
      afterSentAt: after?.sentAt ?? null,
      afterMessageId: after?.messageId ?? null,
      // One beyond the page, so a full page can be told from a last page
      // without a second round trip.
      limit: limit + 1,
    });
    const messages = rows.slice(0, limit);
    const last = messages.at(-1);
    return {
      messages,
      nextCursor:
        rows.length > limit && last
          ? encodeTranscriptCursor(last.sentAt, last.messageId)
          : null,
      pollCursor: last
        ? encodeTranscriptCursor(last.sentAt, last.messageId)
        : input.cursor ?? null,
    };
  }

  async getAgentClarification(
    authenticatedUserId: string,
    draftId: string,
  ): Promise<AgentClarificationTask | null> {
    if (!this.agentClarification) return null;
    const draft = await this.ownedDraft(authenticatedUserId, draftId);
    await this.authorizeDraft(draft, "read");
    if (draft.role !== "recipient") return null;
    return this.agentClarification.loadForRecipient(draftContext(draft));
  }

  async listAgentClarifications(input: Readonly<{
    authenticatedUserId: string;
    githubRepositoryId: string;
    conversationId: string;
  }>): Promise<AgentClarificationTask[]> {
    if (!this.agentClarification) return [];
    await this.authorize(input, "read");
    return this.agentClarification.list({
      actorUserId: input.authenticatedUserId,
      githubRepositoryId: input.githubRepositoryId,
      conversationId: input.conversationId,
    });
  }

  async continueAgentClarificationTask(input: Readonly<{
    authenticatedUserId: string;
    taskId: string;
    currentStepId: string;
    expectedVersion: number;
    answer: string;
  }>): Promise<AgentClarificationTask> {
    if (!this.agentClarification) {
      throw new HttpError(404, "Agent clarification is not available");
    }
    const task = await this.agentClarification.status(
      input.taskId,
      input.authenticatedUserId,
    );
    if (!task || task.expectedUserId !== input.authenticatedUserId) {
      throw new HttpError(409, "Agent clarification is not waiting for this user");
    }
    await this.authorize(
      {
        authenticatedUserId: input.authenticatedUserId,
        githubRepositoryId: task.githubRepositoryId,
        conversationId: task.conversationId,
      },
      "clarify_draft",
    );
    const outcome = await this.agentClarification.continueWithHumanAnswer({
      taskId: input.taskId,
      actorUserId: input.authenticatedUserId,
      currentStepId: input.currentStepId,
      expectedVersion: input.expectedVersion,
      answer: redactPrivateInput(input.answer),
    });
    if (outcome !== "continued") {
      throw new HttpError(409, "Agent clarification cannot continue");
    }
    const updated = await this.agentClarification.status(
      input.taskId,
      input.authenticatedUserId,
    );
    if (!updated) throw new HttpError(409, "Agent clarification cannot continue");
    return updated;
  }

  async stopAgentClarificationTask(
    authenticatedUserId: string,
    taskId: string,
  ): Promise<void> {
    if (!this.agentClarification) return;
    const task = await this.agentClarification.status(taskId, authenticatedUserId);
    if (!task) return;
    await this.authorize(
      {
        authenticatedUserId,
        githubRepositoryId: task.githubRepositoryId,
        conversationId: task.conversationId,
      },
      "cancel",
    );
    if (!(await this.agentClarification.stop(taskId, authenticatedUserId))) {
      throw new HttpError(409, "Agent clarification cannot be stopped");
    }
  }

  async continueAgentClarification(input: Readonly<{
    authenticatedUserId: string;
    draftId: string;
    currentStepId: string;
    expectedVersion: number;
    answer: string;
  }>): Promise<AgentClarificationTask> {
    if (!this.agentClarification) {
      throw new HttpError(404, "Agent clarification is not available");
    }
    const draft = await this.ownedDraft(input.authenticatedUserId, input.draftId);
    await this.authorizeDraft(draft, "clarify_draft");
    const task = await this.agentClarification.loadForRecipient(draftContext(draft));
    if (!task || task.expectedUserId !== input.authenticatedUserId) {
      throw new HttpError(409, "Agent clarification is not waiting for this user");
    }
    const outcome = await this.agentClarification.continueWithHumanAnswer({
      taskId: task.taskId,
      actorUserId: input.authenticatedUserId,
      currentStepId: input.currentStepId,
      expectedVersion: input.expectedVersion,
      answer: redactPrivateInput(input.answer),
    });
    if (outcome !== "continued") {
      throw new HttpError(409, "Agent clarification cannot continue");
    }
    const updated = await this.agentClarification.status(
      task.taskId,
      input.authenticatedUserId,
    );
    if (!updated) throw new HttpError(409, "Agent clarification cannot continue");
    return updated;
  }

  async stopAgentClarification(
    authenticatedUserId: string,
    draftId: string,
  ): Promise<void> {
    if (!this.agentClarification) return;
    const draft = await this.ownedDraft(authenticatedUserId, draftId);
    await this.authorizeDraft(draft, "cancel");
    const task = await this.agentClarification.loadForRecipient(draftContext(draft));
    if (!task) return;
    if (!(await this.agentClarification.stop(task.taskId, authenticatedUserId))) {
      throw new HttpError(409, "Agent clarification cannot be stopped");
    }
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
        : recipientOutputSchema.safeParse(normalizeRecipientOutput(rawOutput));
    if (!parsed.success) {
      return this.failTurn(
        draftId,
        turnId,
        new RuntimeProviderError("INVALID_AGENT_OUTPUT", "Invalid structured output"),
      );
    }
    // Recipient only, and the reason is the provider wire format: the schema
    // accepts an explicit null for `peerClarification` and `resourceRequests`
    // because Structured Outputs forces the model to write one, while
    // `ProtocolTurnOutput` knows only present or absent. Folding here keeps that
    // spelling out of `guardTurn` and everything persisted downstream of it.
    const output: ProtocolTurnOutput =
      "assistantMessage" in parsed.data ? parsed.data : withoutNullOptionals(parsed.data);
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

  /**
   * Runs the follow-up rounds a turn asked for, then settles the draft.
   *
   * The loop lives inside one settling on purpose. Approved bytes travel in
   * flight and are never stored, so the only place they can be used is the
   * prompt of the round that asked for them; a round that spanned two requests
   * would have to keep somebody else's file somewhere in between.
   *
   * The follow-up service owns the human-approval pause. An empty result here
   * therefore means that every request reached a terminal no-delivery state
   * (denied, expired, unavailable, or exhausted), and only then ends the loop.
   */
  private async runFollowUpRounds(
    draft: PrivateDraft,
    first: Awaited<StartedPrivateRuntimeTurn<ProtocolTurnOutput>["completion"]>,
    choice: Readonly<PrivateRunChoice>,
    clarificationTask: AgentClarificationTask | null = null,
  ): Promise<Awaited<StartedPrivateRuntimeTurn<ProtocolTurnOutput>["completion"]>> {
    if (!this.followUp) return first;
    let result = first;
    for (let round = 0; round < MAX_FOLLOW_UP_ROUNDS; round += 1) {
      const requests = result.resourceRequests ?? [];
      if (requests.length === 0) return result;
      this.throwIfCancellationRequested(draft.draftId);

      const followUpWait = this.followUpWaits.get(draft.draftId);
      const delivered = await this.followUp.run(
        {
          incomingMessageId: draft.incomingMessageId,
          conversationId: draft.conversationId,
          githubRepositoryId: draft.githubRepositoryId,
          ownerUserId: draft.ownerUserId,
        },
        requests,
        followUpWait ? { signal: followUpWait.signal } : undefined,
      );
      this.throwIfCancellationRequested(draft.draftId);
      if (delivered.length === 0) return result;

      // A fresh runtime turn, carrying the approved files in its prompt. The
      // draft keeps the turn identifier it claimed, so what the owner sees is
      // still one turn and only the settled result can complete it.
      const started = await this.runtime.start<ProtocolTurnOutput>({
        authorization: this.authorizationInput(draft),
        provider: draft.provider,
        // A later round of the same turn is the same turn. Switching models
        // between rounds would hand the approved files to something other than
        // whatever asked for them, and switching effort would answer the
        // question at a depth the owner never asked for.
        ...(choice.model ? { model: choice.model } : {}),
        ...(choice.effort ? { effort: choice.effort } : {}),
        role: draft.role,
        correlationId: draft.draftId,
        deliveredResources: delivered,
        ...(this.taskSessionReady(clarificationTask, draft)
          ? {
              allowPeerClarification:
                clarificationTask.questionsUsed < MAX_AGENT_CLARIFICATION_QUESTIONS,
              taskSession: {
                taskId: clarificationTask.taskId,
                peerUserId: clarificationTask.requesterUserId,
                participantRole: "responder" as const,
                lane: "private_work" as const,
              },
            }
          : {}),
      });
      // Cancellation has to follow the work, so point it at this round before
      // awaiting it. The draft's own turn identifier never changes.
      this.activeRuntimeTurns.set(draft.draftId, started.turnId);
      if (this.cancellationRequested.has(draft.draftId)) {
        await this.runtime.cancel({
          turnId: started.turnId,
          authenticatedUserId: draft.ownerUserId,
          githubRepositoryId: draft.githubRepositoryId,
          conversationId: draft.conversationId,
        }).catch(() => false);
        throw new RunCancelledError();
      }
      result = await started.completion;
      this.activeRuntimeTurns.set(draft.draftId, null);
    }
    return result;
  }

  /**
   * Whether a task-scoped envelope may be attached to the next job.
   *
   * Runnability is a fact about the task; capability is a fact about the
   * connector, and the connector can change under us. Both are asked here, at
   * the moment the envelope is built, because a connector that reconnected on an
   * older build would reject a task-scoped job outright.
   */
  private taskSessionReady(
    task: AgentClarificationTask | null,
    draft: PrivateDraft,
  ): task is AgentClarificationTask {
    return (
      isRunnableClarificationTask(task, draft.ownerUserId) &&
      (this.agentClarification?.supportsTaskSession(
        draft.ownerUserId,
        draft.githubRepositoryId,
      ) ??
        false)
    );
  }
  private async settleTurn(
    draft: PrivateDraft,
    turnId: string,
    completion: StartedPrivateRuntimeTurn<ProtocolTurnOutput>["completion"],
    choice: Readonly<PrivateRunChoice>,
    initialClarificationTask: AgentClarificationTask | null,
  ): Promise<void> {
    const draftId = draft.draftId;
    const followUpWait = new AbortController();
    this.followUpWaits.set(draftId, followUpWait);
    try {
      const first = await completion;
      this.activeRuntimeTurns.set(draftId, null);
      this.throwIfCancellationRequested(draftId);
      let clarificationTask = initialClarificationTask;
      let result = await this.runFollowUpRounds(
        draft,
        first,
        choice,
        clarificationTask,
      );
      // At most two questions exist in persistence, and every exchange and
      // recipient resume spends the shared five-round budget atomically.
      for (let index = 0; index < 2; index += 1) {
        if (
          !this.agentClarification ||
          !clarificationTask ||
          draft.role !== "recipient"
        ) break;
        const parsed = recipientOutputSchema.safeParse(
          normalizeRecipientOutput(result.final),
        );
        if (!parsed.success || !parsed.data.peerClarification) break;
        const exchanged = await this.agentClarification.exchange(
          clarificationTask,
          parsed.data.peerClarification,
          { signal: followUpWait.signal },
        );
        if (exchanged.outcome !== "resolved") break;
        clarificationTask = exchanged.task;
        // The connector can reconnect on an older build while the peer agent is
        // answering, and capabilities are re-advertised on every readiness beat.
        // A task-scoped envelope would then reach a strict job schema that has
        // never heard of it, and the turn would fail for a reason neither person
        // can see. Stopping here leaves the peer question standing, which is the
        // same fallback taken when the exchange does not resolve.
        if (
          this.agentClarification?.supportsTaskSession(
            draft.ownerUserId,
            draft.githubRepositoryId,
          ) !== true
        ) break;
        const started = await this.runtime.start<ProtocolTurnOutput>({
          authorization: this.authorizationInput(draft),
          provider: draft.provider,
          ...(choice.model ? { model: choice.model } : {}),
          ...(choice.effort ? { effort: choice.effort } : {}),
          role: draft.role,
          correlationId: draft.draftId,
          allowPeerClarification:
            clarificationTask.questionsUsed < MAX_AGENT_CLARIFICATION_QUESTIONS,
          clarificationTranscript: clarificationTranscript(clarificationTask),
          taskSession: {
            taskId: clarificationTask.taskId,
            peerUserId: clarificationTask.requesterUserId,
            participantRole: "responder",
            lane: "private_work",
          },
        });
        this.activeRuntimeTurns.set(draftId, started.turnId);
        this.throwIfCancellationRequested(draftId);
        result = await started.completion;
        this.activeRuntimeTurns.set(draftId, null);
        result = await this.runFollowUpRounds(
          draft,
          result,
          choice,
          clarificationTask,
        );
      }
      await this.completeTurn(draftId, draft.role, turnId, result.final);
    } catch (error) {
      // Runtime and persistence failures are deliberately collapsed to one safe
      // owner-facing state. Raw provider/database errors never enter the draft.
      try {
        await this.endAgentClarification(draft, "cancelled");
        await this.failTurn(draftId, turnId, error);
      } catch {
        // The HTTP request has already returned 202. A durable adapter reports
        // this through its own safe audit/alerting path; never create an
        // unhandled rejection containing infrastructure details.
      }
    } finally {
      // The draft has reached a terminal state either way, so nothing is left
      // to cancel. Clearing the entry keeps this map bounded by the drafts
      // currently running rather than by every draft the process has seen.
      this.activeRuntimeTurns.delete(draftId);
      this.followUpWaits.delete(draftId);
      this.cancellationRequested.delete(draftId);
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

  private throwIfCancellationRequested(draftId: string): void {
    if (this.cancellationRequested.has(draftId)) throw new RunCancelledError();
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

  private async endFollowUp(
    draft: Readonly<PrivateDraft>,
    status: "completed" | "cancelled",
  ): Promise<void> {
    if (!this.followUp || draft.role !== "recipient") return;
    await this.followUp.end(
      {
        incomingMessageId: draft.incomingMessageId,
        conversationId: draft.conversationId,
        githubRepositoryId: draft.githubRepositoryId,
        ownerUserId: draft.ownerUserId,
      },
      status,
    );
  }

  private async endAgentClarification(
    draft: Readonly<PrivateDraft>,
    status: "completed" | "cancelled",
  ): Promise<void> {
    if (!this.agentClarification || draft.role !== "recipient") return;
    const task = await this.agentClarification
      .loadForRecipient(draftContext(draft))
      .catch(() => null);
    if (!task) return;
    if (status === "completed") {
      await this.agentClarification.complete(task.taskId, draft.ownerUserId);
    } else {
      await this.agentClarification.stop(task.taskId, draft.ownerUserId);
    }
  }
}

function draftContext(draft: Readonly<PrivateDraft>) {
  return {
    incomingMessageId: draft.incomingMessageId,
    conversationId: draft.conversationId,
    githubRepositoryId: draft.githubRepositoryId,
    ownerUserId: draft.ownerUserId,
  };
}

function isRunnableClarificationTask(
  task: AgentClarificationTask | null,
  responderUserId: string,
): task is AgentClarificationTask {
  return Boolean(
    task &&
      task.state === "recipient_running" &&
      task.expectedLane === "private_work" &&
      task.expectedUserId === responderUserId,
  );
}

function clarificationTranscript(task: AgentClarificationTask) {
  return task.steps.flatMap((step) => {
    const questionParticipant: "requester" | "responder" =
      step.askedByUserId === task.requesterUserId ? "requester" : "responder";
    const answerParticipant: "requester" | "responder" =
      step.askedToUserId === task.requesterUserId ? "requester" : "responder";
    return [
      ...(step.question
        ? [{ kind: "question" as const, participant: questionParticipant, text: step.question }]
        : []),
      ...(step.answer
        ? [{ kind: "answer" as const, participant: answerParticipant, text: step.answer }]
        : []),
    ];
  });
}

/** Obvious credentials never enter durable private-draft storage unchanged. */
function redactPrivateInput(value: string): string {
  const redacted = redactText(value).value.trim();
  // Input route schemas already require non-empty text. Redaction preserves
  // surrounding labels, and a value consisting only of a secret becomes the
  // explicit placeholder rather than an empty/invalid persistence value.
  return redacted || "[redacted]";
}
