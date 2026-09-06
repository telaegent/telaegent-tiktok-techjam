import { randomUUID } from "node:crypto";
import type { CollaborationTaskRepository } from "../authorization/collaboration-tasks.js";
import type { GitHubRepositoryId } from "../authorization/types.js";
import type { ConnectorResourceRequest } from "../connectors/resource-exchange.js";
import type { DeliveredResourceBlock } from "../telagent/protocol/runtime-adapter.js";
import type { CapabilityFollowUpCoordinator } from "./follow-up-coordinator.js";
import type { CapabilityScopeExpansionService } from "./service.js";

/**
 * The seam between a private draft and the capability loop (build plan 8).
 *
 * A recipient agent finishes a turn holding questions about files that live on
 * the other person's machine. This opens the bounded task that message started,
 * carries one round of those questions across, and hands back only what a human
 * over there had already allowed.
 *
 * It is anchored on the crossing message on purpose. One approved message is
 * one collaboration, with its own five rounds and its own grants, so authority
 * a person delegated for one exchange never carries into the next. A sender
 * draft has no crossing message behind it and therefore no task: its agent can
 * ask for nothing.
 */

export interface FollowUpDraftContext {
  /** The shared message this draft is answering; null for a sender draft. */
  incomingMessageId: string | null;
  conversationId: string;
  githubRepositoryId: GitHubRepositoryId;
  /** The draft's owner: the peer whose agent is asking. */
  ownerUserId: string;
}

export interface PrivateDraftFollowUp {
  run(
    draft: Readonly<FollowUpDraftContext>,
    requests: readonly ConnectorResourceRequest[],
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<readonly DeliveredResourceBlock[]>;
  end(
    draft: Readonly<FollowUpDraftContext>,
    status: "completed" | "cancelled",
  ): Promise<void>;
}

export interface DraftFollowUpServiceDependencies {
  tasks: CollaborationTaskRepository;
  coordinator: CapabilityFollowUpCoordinator;
  scope: CapabilityScopeExpansionService;
  /** Identifier for a task being opened; never derived from its contents. */
  newTaskId?: () => string;
  /** Poll cadence for a durable approval decision. Injectable for tests. */
  approvalPollIntervalMs?: number;
  now?: () => number;
}

export class DraftFollowUpService implements PrivateDraftFollowUp {
  readonly #tasks: CollaborationTaskRepository;
  readonly #coordinator: CapabilityFollowUpCoordinator;
  readonly #scope: CapabilityScopeExpansionService;
  readonly #newTaskId: () => string;
  readonly #approvalPollIntervalMs: number;
  readonly #now: () => number;

  constructor(dependencies: Readonly<DraftFollowUpServiceDependencies>) {
    this.#tasks = dependencies.tasks;
    this.#coordinator = dependencies.coordinator;
    this.#scope = dependencies.scope;
    this.#newTaskId = dependencies.newTaskId ?? randomUUID;
    this.#approvalPollIntervalMs = Math.max(
      50,
      dependencies.approvalPollIntervalMs ?? 750,
    );
    this.#now = dependencies.now ?? Date.now;
  }

  /**
   * Runs one round and returns only what came back.
   *
   * Nothing else about the round is reported to the caller. Whether a question
   * is waiting for a human, was refused, or named a file that does not exist
   * are the same silence here, because the asking peer must not be able to tell
   * those apart. What is pending belongs to the owning human's approval queue,
   * not to the agent that asked.
   */
  async run(
    draft: Readonly<FollowUpDraftContext>,
    requests: readonly ConnectorResourceRequest[],
    options: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ): Promise<readonly DeliveredResourceBlock[]> {
    if (!draft.incomingMessageId || requests.length === 0) return [];

    const task = await this.#tasks.openTask({
      taskId: this.#newTaskId(),
      originSharedMessageId: draft.incomingMessageId,
      responderUserId: draft.ownerUserId,
    });
    if (task.outcome === "unavailable") return [];

    // Scope comes back from the record, never from the draft. The repository a
    // task belongs to is derived from the message that opened it, so a draft
    // that named a different one could not widen anything.
    const context = {
      taskId: task.taskId,
      conversationId: task.conversationId,
      githubRepositoryId: task.githubRepositoryId,
      ownerUserId: task.requesterUserId,
      peerUserId: task.responderUserId,
    } as const;
    const result = await this.#coordinator.runRound(context, requests);
    if (result.outcome !== "completed") return [];
    if (result.delivered.length > 0) return deliveredBlocks(result.delivered);

    // A hint is resolved to an opaque resource only by the owner's connector.
    // Once that same resource is already granted, immediately retry it by ID;
    // sending the hint again would ask the human the same question forever.
    const ready = result.queued
      .filter((queued) => queued.outcome.outcome === "already_granted")
      .map((queued) => exactRequest(queued.candidateResourceId, queued.requestedReason));
    if (ready.length > 0) return this.#deliverApproved(context, ready);

    const waiting = new Map(
      result.queued.flatMap((queued) => {
        const outcome = queued.outcome;
        return outcome.outcome === "recorded" || outcome.outcome === "existing"
          ? [[outcome.scopeRequestId, queued] as const]
          : [];
      }),
    );
    if (waiting.size === 0) return [];

    const expiresAt = Date.parse(task.expiresAt);
    while (waiting.size > 0 && this.#now() < expiresAt) {
      throwIfAborted(options.signal);
      let resolutions;
      try {
        resolutions = await this.#scope.resolveScopeRequests(
          {
            taskId: task.taskId,
            peerUserId: task.responderUserId,
            scopeRequestIds: [...waiting.keys()],
          },
          options.signal ? { signal: options.signal } : undefined,
        );
      } catch (error) {
        if (isAbort(error, options.signal)) throw error;
        // A transient database failure must not turn an approved pause into a
        // failed draft. The durable request remains the source of truth and is
        // read again until the task's existing expiry bound.
        await abortableDelay(
          Math.min(this.#approvalPollIntervalMs, Math.max(0, expiresAt - this.#now())),
          options.signal,
        );
        continue;
      }
      if (resolutions.outcome === "task_unavailable") return [];

      const approved: ConnectorResourceRequest[] = [];
      for (const resolution of resolutions.requests) {
        const queued = waiting.get(resolution.scopeRequestId);
        if (!queued) continue;
        // Both values came from the owner's connector, but require them to
        // agree across the two durable reads before turning a hint into an
        // exact request. A mismatch fails closed rather than being retried.
        if (resolution.candidateResourceId !== queued.candidateResourceId) {
          return [];
        }
        if (resolution.status === "pending") continue;
        waiting.delete(resolution.scopeRequestId);
        if (resolution.status === "approved") {
          approved.push(
            exactRequest(resolution.candidateResourceId, queued.requestedReason),
          );
        }
      }
      if (approved.length > 0) return this.#deliverApproved(context, approved);
      if (waiting.size === 0) return [];

      await abortableDelay(
        Math.min(this.#approvalPollIntervalMs, Math.max(0, expiresAt - this.#now())),
        options.signal,
      );
    }
    return [];
  }

  async #deliverApproved(
    context: Parameters<CapabilityFollowUpCoordinator["runRound"]>[0],
    requests: readonly ConnectorResourceRequest[],
  ): Promise<readonly DeliveredResourceBlock[]> {
    const result = await this.#coordinator.runRound(context, requests);
    return result.outcome === "completed" ? deliveredBlocks(result.delivered) : [];
  }

  /**
   * Closes the task when its recipient draft leaves the private lifecycle.
   *
   * Resolving the task through the crossing message keeps this restart-safe:
   * the database returns the existing task identifier instead of requiring the
   * server process to remember it. Closing it atomically retires every active
   * task-scoped grant.
   */
  async end(
    draft: Readonly<FollowUpDraftContext>,
    status: "completed" | "cancelled",
  ): Promise<void> {
    if (!draft.incomingMessageId) return;
    const task = await this.#tasks.openTask({
      taskId: this.#newTaskId(),
      originSharedMessageId: draft.incomingMessageId,
      responderUserId: draft.ownerUserId,
    });
    if (task.outcome === "unavailable") return;
    const ended = await this.#tasks.endTask({
      taskId: task.taskId,
      actorUserId: draft.ownerUserId,
      status,
    });
    if (ended.outcome === "unavailable" || ended.outcome === "invalid") {
      throw new Error("Collaboration task could not be closed");
    }
  }
}

function exactRequest(resourceId: string, reason: string): ConnectorResourceRequest {
  return { kind: "resource", resourceId, reason };
}

function deliveredBlocks(
  resources: readonly { resourceId: string; content: string; truncated: boolean }[],
): DeliveredResourceBlock[] {
  return resources.map((resource) => ({
    resourceId: resource.resourceId,
    content: resource.content,
    truncated: resource.truncated,
  }));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : abortError();
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function abortError(): Error {
  const error = new Error("Capability approval wait aborted");
  error.name = "AbortError";
  return error;
}

function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
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
