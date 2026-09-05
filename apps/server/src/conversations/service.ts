import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthorizePrivateRuntimeInput } from "../authorization/types.js";
import type { PrivateDraftFollowUp } from "../capability/draft-follow-up.js";
import { HttpError, RunCancelledError } from "../errors.js";
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
  createTurnId?: (() => string) | undefined;
  /**
   * Carries a turn's questions to the other person's machine (build plan 8).
   *
   * Absent by default. Without it a turn that asked for files simply answers
   * with what it already had, which is what every deployment did before the
   * capability loop existed.
   */
  followUp?: PrivateDraftFollowUp | undefined;
}

/**
 * Build plan 8.7. The database holds the same bound on the task itself; this is
 * the in-process copy, so a runtime that never reached the database still stops.
 */
const MAX_FOLLOW_UP_ROUNDS = 5;

/** Largest transcript page one read may return. */
export const MAX_TRANSCRIPT_PAGE_SIZE = 200;

export interface SharedMessageListPage {
  messages: SharedMessage[];
  nextCursor: string | null;
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
    idempotencyKey: string;
  }>): Promise<Readonly<{ draft: PrivateDraftView; replayed: boolean }>> {
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
      privateTurns: input.ownerGuidance
        ? [{ speaker: "owner", text: input.ownerGuidance }]
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
    return { draft: toPrivateDraftView(created.draft), replayed: created.replayed };
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
        role: draft.role,
        correlationId: draft.draftId,
        turnId,
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
    void this.settleTurn(draft, turnId, started.completion);
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
      const ownsExecution = this.activeRuntimeTurns.has(draftId);
      if (ownsExecution) this.cancellationRequested.add(draftId);
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
    await this.endFollowUp(updated, "cancelled");
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
    };
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

  /**
   * Runs the follow-up rounds a turn asked for, then settles the draft.
   *
   * The loop lives inside one settling on purpose. Approved bytes travel in
   * flight and are never stored, so the only place they can be used is the
   * prompt of the round that asked for them; a round that spanned two requests
   * would have to keep somebody else's file somewhere in between.
   *
   * A round that brings nothing back ends the loop rather than retrying. The
   * questions are with a human at that point, and this turn answers with what
   * it already had instead of waiting on a person.
   */
  private async runFollowUpRounds(
    draft: PrivateDraft,
    first: Awaited<StartedPrivateRuntimeTurn<ProtocolTurnOutput>["completion"]>,
  ): Promise<Awaited<StartedPrivateRuntimeTurn<ProtocolTurnOutput>["completion"]>> {
    if (!this.followUp) return first;
    let result = first;
    for (let round = 0; round < MAX_FOLLOW_UP_ROUNDS; round += 1) {
      const requests = result.resourceRequests ?? [];
      if (requests.length === 0) return result;
      this.throwIfCancellationRequested(draft.draftId);

      const delivered = await this.followUp.run(
        {
          incomingMessageId: draft.incomingMessageId,
          conversationId: draft.conversationId,
          githubRepositoryId: draft.githubRepositoryId,
          ownerUserId: draft.ownerUserId,
        },
        requests,
      );
      this.throwIfCancellationRequested(draft.draftId);
      if (delivered.length === 0) return result;

      // A fresh runtime turn, carrying the approved files in its prompt. The
      // draft keeps the turn identifier it claimed, so what the owner sees is
      // still one turn and only the settled result can complete it.
      const started = await this.runtime.start<ProtocolTurnOutput>({
        authorization: this.authorizationInput(draft),
        provider: draft.provider,
        role: draft.role,
        correlationId: draft.draftId,
        deliveredResources: delivered,
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

  private async settleTurn(
    draft: PrivateDraft,
    turnId: string,
    completion: StartedPrivateRuntimeTurn<ProtocolTurnOutput>["completion"],
  ): Promise<void> {
    const draftId = draft.draftId;
    try {
      const first = await completion;
      this.activeRuntimeTurns.set(draftId, null);
      this.throwIfCancellationRequested(draftId);
      const result = await this.runFollowUpRounds(draft, first);
      await this.completeTurn(draftId, draft.role, turnId, result.final);
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
    } finally {
      // The draft has reached a terminal state either way, so nothing is left
      // to cancel. Clearing the entry keeps this map bounded by the drafts
      // currently running rather than by every draft the process has seen.
      this.activeRuntimeTurns.delete(draftId);
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
}
