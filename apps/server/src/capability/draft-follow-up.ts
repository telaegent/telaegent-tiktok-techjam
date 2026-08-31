import { randomUUID } from "node:crypto";
import type { CollaborationTaskRepository } from "../authorization/collaboration-tasks.js";
import type { GitHubRepositoryId } from "../authorization/types.js";
import type { ConnectorResourceRequest } from "../connectors/resource-exchange.js";
import type { DeliveredResourceBlock } from "../telagent/protocol/runtime-adapter.js";
import type { CapabilityFollowUpCoordinator } from "./follow-up-coordinator.js";

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
  ): Promise<readonly DeliveredResourceBlock[]>;
}

export interface DraftFollowUpServiceDependencies {
  tasks: CollaborationTaskRepository;
  coordinator: CapabilityFollowUpCoordinator;
  /** Identifier for a task being opened; never derived from its contents. */
  newTaskId?: () => string;
}

export class DraftFollowUpService implements PrivateDraftFollowUp {
  readonly #tasks: CollaborationTaskRepository;
  readonly #coordinator: CapabilityFollowUpCoordinator;
  readonly #newTaskId: () => string;

  constructor(dependencies: Readonly<DraftFollowUpServiceDependencies>) {
    this.#tasks = dependencies.tasks;
    this.#coordinator = dependencies.coordinator;
    this.#newTaskId = dependencies.newTaskId ?? randomUUID;
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
    const result = await this.#coordinator.runRound(
      {
        taskId: task.taskId,
        conversationId: task.conversationId,
        githubRepositoryId: task.githubRepositoryId,
        ownerUserId: task.requesterUserId,
        peerUserId: task.responderUserId,
      },
      requests,
    );
    if (result.outcome !== "completed") return [];

    return result.delivered.map((resource) => ({
      resourceId: resource.resourceId,
      content: resource.content,
      truncated: resource.truncated,
    }));
  }
}
