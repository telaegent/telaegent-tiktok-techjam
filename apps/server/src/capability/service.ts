import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type {
  CapabilityFollowUpRoundOutcome,
  CapabilityScopeDecision,
  CapabilityScopeRequestOptions,
  CapabilityScopeRequestRepository,
  PendingCapabilityScopeRequest,
  RecordCapabilityScopeRequestOutcome,
} from "../authorization/capability-scope-requests.js";
import type { GitHubRepositoryId } from "../authorization/types.js";

export interface CapabilityScopeExpansionServiceDependencies {
  repository: CapabilityScopeRequestRepository;
  /**
   * Identifiers this service allocates before it calls the database, so a
   * retried request lands on the same row and the same grant instead of
   * creating a second one.
   */
  newId?: () => string;
}

export interface ListPendingScopeRequestsInput {
  authenticatedUserId: string;
  githubRepositoryId: GitHubRepositoryId;
}

export interface DecideScopeRequestInput {
  authenticatedUserId: string;
  scopeRequestId: string;
  decision: CapabilityScopeDecision;
}

export interface QueueScopeRequestInput {
  taskId: string;
  ownerUserId: string;
  peerUserId: string;
  requestedHint: string | null;
  requestedReason: string;
  candidateResourceId: string;
}

export interface ScopeDecisionResult {
  outcome: "approved" | "denied";
  grantId?: string;
  mode?: "once" | "task";
}

/**
 * The human gate on top of the capability loop (build plan 8.1).
 *
 * A peer's agent may ask for a file it was never given. This service is what
 * makes that ask wait: it queues the question, shows it to exactly one person,
 * and turns their answer into authority or into nothing. It never reads a file,
 * never sees a path, and never decides anything itself — the database functions
 * hold the invariants, and this layer only translates them into HTTP.
 */
export class CapabilityScopeExpansionService {
  readonly #repository: CapabilityScopeRequestRepository;
  readonly #newId: () => string;

  constructor(dependencies: Readonly<CapabilityScopeExpansionServiceDependencies>) {
    this.#repository = dependencies.repository;
    this.#newId = dependencies.newId ?? randomUUID;
  }

  /**
   * What this person is being asked to decide, inside this repository only.
   *
   * No membership check is layered on top: the query is keyed on the owner, so
   * a caller can only ever be shown questions addressed to them, and repository
   * ID still bounds which of those they see.
   */
  async listPendingScopeRequests(
    input: Readonly<ListPendingScopeRequestsInput>,
    options?: Readonly<CapabilityScopeRequestOptions>,
  ): Promise<{ requests: readonly PendingCapabilityScopeRequest[] }> {
    const requests = await this.#repository.listPendingScopeRequests(
      {
        ownerUserId: input.authenticatedUserId,
        githubRepositoryId: input.githubRepositoryId,
      },
      options,
    );
    return { requests };
  }

  /**
   * Records Deny, Allow once, or Allow for this task.
   *
   * The grant identifier is allocated here and handed down, so pressing the
   * button twice cannot mint two authorities over the same file.
   */
  async decideScopeRequest(
    input: Readonly<DecideScopeRequestInput>,
    options?: Readonly<CapabilityScopeRequestOptions>,
  ): Promise<ScopeDecisionResult> {
    const result = await this.#repository.decideScopeRequest(
      {
        scopeRequestId: input.scopeRequestId,
        ownerUserId: input.authenticatedUserId,
        decision: input.decision,
        grantId: this.#newId(),
      },
      options,
    );

    switch (result.outcome) {
      case "denied":
        return { outcome: "denied" };
      case "approved":
        return {
          outcome: "approved",
          grantId: result.grantId,
          mode: result.mode,
        };
      case "unavailable":
        // One answer for every way this can fail. Whether the request never
        // existed, belongs to someone else, or was already decided is not
        // something a caller may learn by trying.
        throw new HttpError(404, "That request is not awaiting your decision");
      case "task_unavailable":
        throw new HttpError(
          409,
          "That collaboration has ended, so it can no longer be widened",
        );
      case "invalid":
        throw new HttpError(400, "That decision is not one of the offered choices");
    }
  }

  /**
   * Puts one ask in front of the owning human.
   *
   * Called by the loop, never by a browser: a peer cannot queue a question for
   * itself. `already_granted` is the warm path — authority the human already
   * delegated is reused rather than asked for a second time.
   */
  async queueScopeRequest(
    input: Readonly<QueueScopeRequestInput>,
    options?: Readonly<CapabilityScopeRequestOptions>,
  ): Promise<RecordCapabilityScopeRequestOutcome> {
    return this.#repository.recordScopeRequest(
      { scopeRequestId: this.#newId(), ...input },
      options,
    );
  }

  /**
   * Spends one of the five follow-up rounds build plan 8.7 allows.
   *
   * The budget belongs to the task, so it cannot be refilled by swapping which
   * peer is asking.
   */
  async beginFollowUpRound(
    input: Readonly<{ taskId: string; ownerUserId: string; peerUserId: string }>,
    options?: Readonly<CapabilityScopeRequestOptions>,
  ): Promise<CapabilityFollowUpRoundOutcome> {
    return this.#repository.beginFollowUpRound(input, options);
  }
}
