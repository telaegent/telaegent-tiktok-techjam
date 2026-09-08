import { randomUUID } from "node:crypto";
import type { CollaborationTaskRepository } from "../authorization/collaboration-tasks.js";
import type { GitHubRepositoryId } from "../authorization/types.js";
import type { StartedPrivateRuntimeTurn } from "../private-runtime-turn-coordinator.js";
import type { AgentProvider } from "../runtime-contract.js";
import type { RuntimeEffort } from "../runtime-efforts.js";
import type { AuthorizedProtocolTurnService } from "../telagent/protocol/authorized-turn-service.js";
import {
  clarificationDialogueOutputSchema,
  hashClarificationText,
  restrictToApprovedBasis,
  type PeerClarification,
} from "./contract.js";
import type {
  AgentClarificationContext,
  AgentClarificationContextLoader,
} from "./context-loader.js";
import { buildAgentClarificationPrompt } from "./prompt.js";
import type {
  AgentClarificationRepository,
  AgentClarificationTask,
} from "./repository.js";

export interface AgentClarificationDraftContext {
  incomingMessageId: string | null;
  conversationId: string;
  githubRepositoryId: GitHubRepositoryId;
  ownerUserId: string;
}

export interface AgentClarificationChoice {
  provider: AgentProvider;
  model?: string | undefined;
  effort?: RuntimeEffort | undefined;
}

export type AgentClarificationExchangeOutcome =
  | { outcome: "resolved"; task: AgentClarificationTask }
  | { outcome: "not_enabled" }
  | { outcome: "exhausted" }
  | { outcome: "cancelled" };

export interface AgentClarificationCoordinatorOptions {
  createId?: () => string;
  /**
   * How long a wait for a person may sit before the task is re-read anyway.
   *
   * Not a poll interval. The answer arrives over HTTP into this same process
   * and wakes the parked exchange directly, so this only bounds a wake that
   * never comes. It used to be a 750ms poll, which spends roughly 4,800 reads
   * on someone who takes the full hour a collaboration task is allowed to live.
   */
  humanWaitBackstopMs?: number;
  now?: () => number;
  /**
   * Plan section 7.1. True only when that participant has a live connector
   * binding advertising protocol version 2 with both `task_sessions_v1` and
   * `peer_clarification_v1`. A false answer means the connector is too old to
   * understand the task envelope, which is not the same as being unavailable.
   */
  supportsCapabilities: (
    userId: string,
    githubRepositoryId: string,
  ) => boolean;
}

/**
 * Server-owned, iterative orchestration. A provider result is persisted and
 * its connector lease released before the next participant is dispatched.
 */
export class AgentClarificationCoordinator {
  readonly #createId: () => string;
  readonly #humanWaitBackstopMs: number;
  readonly #now: () => number;
  /** Parked `#drive` loops, keyed by task, woken by the answer they wait on. */
  readonly #humanWaits = new Map<string, Set<() => void>>();

  constructor(
    private readonly tasks: CollaborationTaskRepository,
    private readonly repository: AgentClarificationRepository,
    private readonly context: AgentClarificationContextLoader,
    private readonly runtime: AuthorizedProtocolTurnService,
    private readonly options: AgentClarificationCoordinatorOptions,
  ) {
    this.#createId = options.createId ?? randomUUID;
    this.#humanWaitBackstopMs = Math.max(
      100,
      options.humanWaitBackstopMs ?? 30_000,
    );
    this.#now = options.now ?? Date.now;
  }

  async grantOriginator(input: Readonly<{
    originSharedMessageId: string;
    actorUserId: string;
    choice: AgentClarificationChoice;
  }>): Promise<boolean> {
    const result = await this.repository.grantOriginator({
      originSharedMessageId: input.originSharedMessageId,
      actorUserId: input.actorUserId,
      provider: input.choice.provider,
      model: input.choice.model ?? null,
    });
    return result.outcome === "granted";
  }

  /**
   * Withdraws the originator's consent for one shared message.
   *
   * Waking the cancelled exchanges is the point of doing this here rather than
   * leaving the RPC to the caller: an exchange parked on a person's answer is
   * parked in this process, and revocation has just made that question
   * unanswerable. Without the wake it would sit there until the backstop.
   */
  async revokeOriginator(input: Readonly<{
    originSharedMessageId: string;
    actorUserId: string;
  }>): Promise<boolean> {
    const result = await this.repository.revokeOriginator(input);
    if (result.outcome !== "revoked") return false;
    for (const taskId of result.cancelledTaskIds) this.#wake(taskId);
    return true;
  }

  /** Opens the canonical message task and records the responder's second grant. */
  async activateForRecipient(
    draft: Readonly<AgentClarificationDraftContext>,
    choice: Readonly<AgentClarificationChoice>,
  ): Promise<AgentClarificationTask | null> {
    if (!draft.incomingMessageId) return null;
    if (!this.#capable(draft)) return null;
    // `openTask` is idempotent on the origin message, so this generated id is
    // discarded whenever the task already exists.
    const opened = await this.tasks.openTask({
      taskId: this.#createId(),
      originSharedMessageId: draft.incomingMessageId,
      responderUserId: draft.ownerUserId,
    });
    if (opened.outcome === "unavailable") return null;
    const activated = await this.repository.activate({
      taskId: opened.taskId,
      responderUserId: draft.ownerUserId,
      provider: choice.provider,
      model: choice.model ?? null,
    });
    return activated.outcome === "active" ? activated.task : null;
  }

  /** Looks up an already bilaterally-enabled task without creating authority. */
  async loadForRecipient(
    draft: Readonly<AgentClarificationDraftContext>,
  ): Promise<AgentClarificationTask | null> {
    if (!draft.incomingMessageId) return null;
    // Returning null here is what keeps a protocol-v1 connector safe: the
    // caller attaches no `taskSession`, so no version-2 envelope field is ever
    // built for a binding whose job schema would reject it.
    if (!this.#capable(draft)) return null;
    const opened = await this.tasks.openTask({
      taskId: this.#createId(),
      originSharedMessageId: draft.incomingMessageId,
      responderUserId: draft.ownerUserId,
    });
    if (opened.outcome === "unavailable") return null;
    const loaded = await this.repository.load({
      taskId: opened.taskId,
      actorUserId: draft.ownerUserId,
    });
    return loaded.outcome === "available" ? loaded.task : null;
  }

  async exchange(
    task: AgentClarificationTask,
    question: Readonly<PeerClarification>,
    options: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ): Promise<AgentClarificationExchangeOutcome> {
    // Shared basis ids are evidence hints the model produced, so they are
    // narrowed to the capsule the server already approved for this asker
    // before they are persisted. They never widen what the peer may read.
    const approved = await this.context
      .load({ taskId: task.taskId, actorUserId: task.responderUserId })
      .catch(() => null);
    const narrowed = restrictToApprovedBasis(question, approvedIds(approved));
    const begun = await this.repository.beginQuestion({
      taskId: task.taskId,
      actorUserId: task.responderUserId,
      stepId: this.#createId(),
      question: narrowed.question,
      reasonCode: narrowed.reasonCode,
      sharedBasisMessageIds: narrowed.sharedBasisMessageIds,
      contentHash: hashClarificationText(narrowed.question),
      expectedVersion: task.version,
    });
    if (begun.outcome === "exhausted") return { outcome: "exhausted" };
    if (begun.outcome !== "route_dialogue") return { outcome: "not_enabled" };
    return this.#drive(begun.task, options.signal);
  }

  /** Human answer plus the explicit Continue action in one authenticated call. */
  async continueWithHumanAnswer(input: Readonly<{
    taskId: string;
    actorUserId: string;
    currentStepId: string;
    answer: string;
    expectedVersion: number;
  }>): Promise<"continued" | "exhausted" | "stale" | "unavailable"> {
    const result = await this.repository.continueWithHumanAnswer({
      ...input,
      answerHash: hashClarificationText(input.answer),
    });
    if (result.outcome === "route_dialogue" || result.outcome === "resume_recipient") {
      // The exchange this answer unblocks is parked in this process waiting on
      // exactly this call. Waking it here is what replaced re-reading the task
      // on a timer until the answer happened to show up.
      this.#wake(input.taskId);
      return "continued";
    }
    return result.outcome === "human_required" ? "unavailable" : result.outcome;
  }

  async status(taskId: string, actorUserId: string): Promise<AgentClarificationTask | null> {
    const result = await this.repository.load({ taskId, actorUserId });
    return result.outcome === "available" ? result.task : null;
  }

  list(input: Readonly<{
    actorUserId: string;
    githubRepositoryId: string;
    conversationId: string;
  }>): Promise<AgentClarificationTask[]> {
    return this.repository.list(input);
  }

  async stop(taskId: string, actorUserId: string): Promise<boolean> {
    const result = await this.repository.stop({ taskId, actorUserId });
    // Unconditional, including the outcomes that changed nothing: a wake costs
    // one read and the loop re-decides from the row, while a missed wake leaves
    // an exchange parked on a question its task no longer has.
    this.#wake(taskId);
    return result.outcome === "stopped" || result.outcome === "already_terminal";
  }

  async complete(taskId: string, actorUserId: string): Promise<void> {
    await this.repository.complete({ taskId, actorUserId });
  }

  /**
   * Cancels every exchange a restart left mid-flight. Call once, before serving.
   *
   * What advances an exchange lives in this process: `#drive` holds the task
   * between rounds, and a person's answer reaches it through `#humanWaits`.
   * A restart loses all of that while the rows survive, so a task left in
   * `dialogue_running` or `human_required` is one nothing will ever advance.
   * `human_required` is the visible one -- the owner is still offered an answer
   * box for a question no answer can now reach.
   *
   * Cancelling is the honest end rather than a resume, because the draft the
   * exchange hangs off has already been failed by the private-draft reconciler
   * that runs beside this: there is nothing left to resume into. Both people
   * can start again, which is a thing they can actually do.
   */
  async reconcileAbandoned(): Promise<number> {
    return this.repository.reconcileDriving({
      updatedAt: new Date(this.#now()).toISOString(),
    });
  }

  /**
   * Deletes clarification text whose task lifetime has run out.
   *
   * Opening a new exchange already sweeps, which covers a busy deployment and
   * nothing else: the exchange both people abandon is never touched again, and
   * on a quiet day nothing opens. Its text is the only cross-user question and
   * answer this feature persists, so its deletion cannot be left to depend on
   * somebody else starting a conversation.
   */
  async sweepExpiredPayloads(): Promise<number> {
    return this.repository.sweepExpiredPayloads();
  }

  /**
   * Whether this connector can still be handed a task-scoped job right now.
   *
   * Capabilities are re-advertised on every readiness beat, so a connector that
   * reconnects on an older build between the check at task creation and the
   * recipient resume drops back to protocol version 1. It would then receive a
   * task-scoped envelope its strict job schema rejects, and the turn fails for a
   * reason neither person can see. Callers that attach a taskSession re-ask here
   * rather than trusting the answer from the start of the task.
   */
  supportsTaskSession(userId: string, githubRepositoryId: string): boolean {
    return this.options.supportsCapabilities(userId, githubRepositoryId);
  }

  /**
   * The recipient is the only participant whose connector receives the first
   * task-scoped job, so its advertisement decides whether the task may exist.
   */
  #capable(draft: Readonly<AgentClarificationDraftContext>): boolean {
    return this.options.supportsCapabilities(
      draft.ownerUserId,
      draft.githubRepositoryId,
    );
  }

  /** Wakes every `#drive` loop parked on this task's human step. */
  #wake(taskId: string): void {
    const parked = this.#humanWaits.get(taskId);
    if (!parked) return;
    this.#humanWaits.delete(taskId);
    for (const resume of parked) resume();
  }

  /**
   * Parks until the person answers, the backstop elapses, or the caller aborts.
   *
   * The backstop's timer keeps running when the answer wins the race. Nothing
   * awaits it by then, so a later abort would reject it into no one; that
   * rejection is claimed here rather than left to surface as an unhandled one.
   */
  async #awaitHuman(
    taskId: string,
    backstopMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    // Built before the waiter is registered: an already-aborted signal throws
    // out of here synchronously, and must not leave an entry in the map.
    const backstop = delay(backstopMs, signal);
    backstop.catch(() => undefined);
    let resume!: () => void;
    const answered = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const parked = this.#humanWaits.get(taskId) ?? new Set<() => void>();
    parked.add(resume);
    this.#humanWaits.set(taskId, parked);
    try {
      await Promise.race([answered, backstop]);
    } finally {
      const waiting = this.#humanWaits.get(taskId);
      waiting?.delete(resume);
      if (waiting?.size === 0) this.#humanWaits.delete(taskId);
    }
  }

  async #drive(
    initial: AgentClarificationTask,
    signal?: AbortSignal,
  ): Promise<AgentClarificationExchangeOutcome> {
    let task = initial;
    while (true) {
      throwIfAborted(signal);
      if (Date.parse(task.expiresAt) <= this.#now()) return { outcome: "cancelled" };
      if (task.state === "recipient_running" && task.expectedLane === "private_work") {
        return { outcome: "resolved", task };
      }
      if (task.state === "completed" || task.state === "cancelled" || task.state === "expired") {
        return { outcome: "cancelled" };
      }
      if (task.state === "human_required") {
        // Parked on a person, not on a timer. The answer arrives over HTTP into
        // this same process and wakes this loop directly, so the wait costs one
        // read when it ends instead of one read for every poll while it lasts.
        await this.#awaitHuman(
          task.taskId,
          Math.min(
            this.#humanWaitBackstopMs,
            Math.max(0, Date.parse(task.expiresAt) - this.#now()),
          ),
          signal,
        );
        const loaded = await this.repository.load({
          taskId: task.taskId,
          actorUserId: task.responderUserId,
        });
        if (loaded.outcome !== "available") return { outcome: "cancelled" };
        task = loaded.task;
        continue;
      }
      if (
        task.state !== "dialogue_running" ||
        task.expectedLane !== "clarification_dialogue" ||
        !task.expectedUserId ||
        !task.currentStepId
      ) {
        return { outcome: "not_enabled" };
      }

      const actorUserId = task.expectedUserId;
      if (
        !this.options.supportsCapabilities(actorUserId, task.githubRepositoryId)
      ) {
        await this.repository.stop({ taskId: task.taskId, actorUserId: task.responderUserId });
        return { outcome: "not_enabled" };
      }
      const approvedContext = await this.context.load({ taskId: task.taskId, actorUserId });
      if (!approvedContext) return { outcome: "not_enabled" };
      const prompt = buildAgentClarificationPrompt({
        task,
        context: approvedContext,
        actorUserId,
      });
      const version = task.version;
      const stepId = task.currentStepId;
      const choice = participantChoice(task, actorUserId);
      const actorIsRequester = actorUserId === task.requesterUserId;
      let started: StartedPrivateRuntimeTurn;
      try {
        started = await this.runtime.startClarificationDialogue({
          authorization: {
            authenticatedUserId: actorUserId,
            githubRepositoryId: task.githubRepositoryId,
            conversationId: task.conversationId,
          },
          provider: choice.provider,
          ...(choice.model ? { model: choice.model } : {}),
          taskId: task.taskId,
          peerUserId: actorIsRequester
            ? task.responderUserId
            : task.requesterUserId,
          // Derived from the task, never from anything the model said. It
          // labels the envelope; it is not routing authority.
          participantRole: actorIsRequester ? "requester" : "responder",
          stepId,
          runtimePrompt: prompt,
          revalidate: async () => {
            const current = await this.repository.load({
              taskId: task.taskId,
              actorUserId,
            });
            if (
              current.outcome !== "available" ||
              current.task.version !== version ||
              current.task.state !== "dialogue_running" ||
              current.task.expectedUserId !== actorUserId ||
              current.task.currentStepId !== stepId
            ) {
              throw new Error("Agent clarification reservation is no longer active");
            }
          },
        });
      } catch {
        await this.repository.stop({ taskId: task.taskId, actorUserId: task.responderUserId });
        return { outcome: "not_enabled" };
      }
      let raw: unknown;
      try {
        raw = (await started.completion).final;
      } catch {
        await this.repository.stop({ taskId: task.taskId, actorUserId: task.responderUserId });
        return { outcome: "not_enabled" };
      }
      const output = clarificationDialogueOutputSchema.safeParse(raw);
      if (!output.success || output.data.replyToStepId !== stepId) {
        await this.repository.stop({ taskId: task.taskId, actorUserId: task.responderUserId });
        return { outcome: "not_enabled" };
      }
      const narrowed = narrowDialogueBasis(output.data, approvedIds(approvedContext));
      const text = narrowed.answer ?? narrowed.counterQuestion?.question ?? null;
      const recorded = await this.repository.recordDialogueResult({
        taskId: task.taskId,
        actorUserId,
        currentStepId: stepId,
        counterStepId: this.#createId(),
        expectedVersion: version,
        output: narrowed,
        contentHash: text === null ? null : hashClarificationText(text),
      });
      if (recorded.outcome === "exhausted") return { outcome: "exhausted" };
      if (recorded.outcome === "stale" || recorded.outcome === "unavailable") {
        return { outcome: "not_enabled" };
      }
      task = recorded.task;
    }
  }
}

function participantChoice(
  task: AgentClarificationTask,
  userId: string,
): { provider: AgentProvider; model: string | null } {
  if (userId === task.requesterUserId) {
    return { provider: task.requesterProvider, model: task.requesterModel };
  }
  if (userId === task.responderUserId) {
    return { provider: task.responderProvider, model: task.responderModel };
  }
  throw new Error("Agent clarification participant is invalid");
}

function approvedIds(
  context: AgentClarificationContext | null,
): ReadonlySet<string> {
  return new Set(context?.sharedHistory.map((message) => message.messageId) ?? []);
}

/** Narrows both the turn-level hints and the counter-question's own. */
function narrowDialogueBasis<
  T extends {
    readonly sharedBasisMessageIds: readonly string[];
    readonly counterQuestion:
      | { readonly sharedBasisMessageIds: readonly string[] }
      | null;
  },
>(value: T, approved: ReadonlySet<string>): T {
  const narrowed = restrictToApprovedBasis(value, approved);
  return narrowed.counterQuestion === null
    ? narrowed
    : {
        ...narrowed,
        counterQuestion: restrictToApprovedBasis(
          narrowed.counterQuestion,
          approved,
        ),
      };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : abortError();
}

function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : abortError());
    };
    function cleanup() {
      signal?.removeEventListener("abort", onAbort);
    }
    function done() {
      cleanup();
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("Agent clarification wait aborted");
  error.name = "AbortError";
  return error;
}
