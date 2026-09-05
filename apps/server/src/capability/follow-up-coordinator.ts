import { randomUUID } from "node:crypto";
import type { CapabilityGrantRepository } from "../authorization/capability-grants.js";
import { CapabilityRouteAuthorizationError } from "../authorization/capability-route-authorization.js";
import type {
  AuthorizeCapabilityRouteInput,
  AuthorizedCapabilityRoute,
  ResolveCapabilityRouteInput,
  ResolvedCapabilityRoute,
} from "../authorization/capability-types.js";
import type { RecordCapabilityScopeRequestOutcome } from "../authorization/capability-scope-requests.js";
import type { GitHubRepositoryId } from "../authorization/types.js";
import type { AssertedGrant } from "../connectors/resource-policy.js";
import type {
  ConnectorResourceRequest,
  ResourceExchangeRequest,
  ResourceExchangeResponse,
} from "../connectors/resource-exchange.js";
import type { CapabilityScopeExpansionService } from "./service.js";

/**
 * One round of the follow-up loop (build plan 8.2 to 8.7).
 *
 * A private agent finishes a turn holding questions about files it cannot see.
 * This is what carries those questions to the other machine and brings back
 * whatever a human already allowed: it spends a round from the task's budget,
 * asserts the grants the peer already holds, routes the batch to the owner's
 * connector, and puts anything new in front of the owning human.
 *
 * It routes; it never decides. No path is constructed here, no file is opened
 * here, and no authority is created here. Every byte in the result was read on
 * the owner's machine, by the owner's connector, under a grant a person pressed.
 */

export interface CapabilityRouteAuthorizer {
  authorizeRoute(
    input: Readonly<AuthorizeCapabilityRouteInput>,
  ): Promise<AuthorizedCapabilityRoute>;
  resolveRoute(
    input: Readonly<ResolveCapabilityRouteInput>,
  ): Promise<ResolvedCapabilityRoute>;
}

export interface CapabilityResourceRelay {
  exchangeResources(
    request: Readonly<ResourceExchangeRequest>,
  ): Promise<ResourceExchangeResponse>;
}

/**
 * A grant the peer is already holding for this task.
 *
 * Authority belongs to the task, not to a round: what a human approved during
 * one turn is still approved during the next. The ledger is read from the
 * record of what people pressed, never accepted from a caller, so no code path
 * can assert an authority by describing one.
 */
export interface HeldCapabilityGrant {
  grantId: string;
  resourceId: string;
}

export interface CapabilityFollowUpContext {
  taskId: string;
  conversationId: string;
  githubRepositoryId: GitHubRepositoryId;
  /** Whose repository is being read. */
  ownerUserId: string;
  /** Whose agent is asking. */
  peerUserId: string;
}

export interface DeliveredResource {
  resourceId: string;
  content: string;
  truncated: boolean;
  byteLength: number;
}

export interface QueuedScopeRequest {
  candidateResourceId: string;
  resourceDisplayLabel: string;
  requestedHint: string | null;
  requestedReason: string;
  outcome: RecordCapabilityScopeRequestOutcome;
}

export type CapabilityFollowUpOutcome =
  | {
      outcome: "completed";
      /** Which of the five rounds this was; 0 when nothing was asked. */
      round: number;
      delivered: DeliveredResource[];
      queued: QueuedScopeRequest[];
      /**
       * Asks the owner's machine did not turn into a question for a human.
       * A missing file, a screened-out secret and a file simply awaiting a
       * person are all counted here and are indistinguishable from outside.
       */
      pendingWithoutCandidate: number;
      refused: number;
      /** Grants the caller must drop from its ledger; "once" means once. */
      spentGrantIds: string[];
    }
  | { outcome: "exhausted"; round: number }
  /**
   * The round was spent and there was nowhere to deliver it: the connection
   * was revoked, the owner's connector is not ready, or the task no longer
   * spans both people. Why is deliberately not said.
   */
  | { outcome: "unroutable"; round: number }
  | { outcome: "task_unavailable" };

export class CapabilityFollowUpError extends Error {
  constructor(
    public readonly code:
      | "CAPABILITY_BINDING_MISMATCH"
      | "CAPABILITY_GRANT_STATE_MISMATCH",
  ) {
    super("Capability follow-up cannot be routed");
    this.name = "CapabilityFollowUpError";
  }
}

export interface CapabilityFollowUpCoordinatorDependencies {
  scope: CapabilityScopeExpansionService;
  authorization: CapabilityRouteAuthorizer;
  relay: CapabilityResourceRelay;
  grants: CapabilityGrantRepository;
  /** Correlation identifier for one batch; never derived from its contents. */
  newRequestId?: () => string;
  /** Build plan 8.7: bounded requests per round. */
  maxRequestsPerRound?: number;
}

/** Matches the batch bound the connector's own exchange schema enforces. */
const MAX_REQUESTS_PER_ROUND = 16;

export class CapabilityFollowUpCoordinator {
  readonly #scope: CapabilityScopeExpansionService;
  readonly #authorization: CapabilityRouteAuthorizer;
  readonly #relay: CapabilityResourceRelay;
  readonly #grants: CapabilityGrantRepository;
  readonly #newRequestId: () => string;
  readonly #maxRequests: number;

  constructor(dependencies: Readonly<CapabilityFollowUpCoordinatorDependencies>) {
    this.#scope = dependencies.scope;
    this.#authorization = dependencies.authorization;
    this.#relay = dependencies.relay;
    this.#grants = dependencies.grants;
    this.#newRequestId = dependencies.newRequestId ?? randomUUID;
    this.#maxRequests = Math.min(
      dependencies.maxRequestsPerRound ?? MAX_REQUESTS_PER_ROUND,
      MAX_REQUESTS_PER_ROUND,
    );
  }

  /**
   * Runs one follow-up round on behalf of the asking peer.
   *
   * The round is spent before anything else happens. A round that fails still
   * costs one, because the budget exists to stop a loop that cannot make
   * progress, and a loop that keeps failing is exactly that.
   */
  async runRound(
    context: Readonly<CapabilityFollowUpContext>,
    requested: readonly ConnectorResourceRequest[],
  ): Promise<CapabilityFollowUpOutcome> {
    const requests = dedupe(requested).slice(0, this.#maxRequests);
    if (requests.length === 0) {
      return {
        outcome: "completed",
        round: 0,
        delivered: [],
        queued: [],
        pendingWithoutCandidate: 0,
        refused: 0,
        spentGrantIds: [],
      };
    }

    const round = await this.#scope.beginFollowUpRound({
      taskId: context.taskId,
      ownerUserId: context.ownerUserId,
      peerUserId: context.peerUserId,
    });
    if (round.outcome === "task_unavailable") return { outcome: "task_unavailable" };
    if (round.outcome === "exhausted") {
      return { outcome: "exhausted", round: round.round };
    }

    // Where this batch may go is derived, never supplied. A caller that could
    // name the connector could name someone else's, and a first ask - which
    // reuses no grant at all - would otherwise have no route to travel.
    let route: ResolvedCapabilityRoute;
    try {
      route = await this.#authorization.resolveRoute({
        authenticatedUserId: context.peerUserId,
        ownerUserId: context.ownerUserId,
        githubRepositoryId: context.githubRepositoryId,
        conversationId: context.conversationId,
        taskId: context.taskId,
      });
    } catch (error) {
      if (
        error instanceof CapabilityRouteAuthorizationError &&
        error.code === "CAPABILITY_ROUTE_FORBIDDEN"
      ) {
        return { outcome: "unroutable", round: round.round };
      }
      throw error;
    }

    const held = await this.#loadHeldGrants(context);
    const prepared = await this.#prepareGrantAssertions(
      context,
      requests,
      held,
      route,
    );

    const response = await this.#relay.exchangeResources({
      requestId: this.#newRequestId(),
      taskId: context.taskId,
      conversationId: context.conversationId,
      taskExpiresAt: route.taskExpiresAt,
      connectorBindingId: route.ownerRuntimeBindingId,
      peerUserId: context.peerUserId,
      requests: [...requests],
      grants: prepared.grants,
    });

    return await this.#collect(
      context,
      requests,
      prepared,
      response,
      round.round,
    );
  }

  /**
   * Reads back what a human already allowed inside this task.
   *
   * A ledger that cannot be read is treated as an empty one. That costs a round
   * and sends the questions back to a person, which is the safe direction to
   * fail in: the alternative would be asserting authority the cloud is no
   * longer sure of.
   */
  async #loadHeldGrants(
    context: Readonly<CapabilityFollowUpContext>,
  ): Promise<Map<string, HeldCapabilityGrant>> {
    const listed = await this.#grants.listTaskGrants({
      taskId: context.taskId,
      ownerUserId: context.ownerUserId,
      peerUserId: context.peerUserId,
    });
    if (listed.outcome !== "listed") return new Map();
    return new Map(listed.grants.map((grant) => [grant.resourceId, grant]));
  }

  /**
   * Turns grants the peer already holds into assertions on the batch.
   *
   * A grant that no longer authorizes anything is dropped rather than raised:
   * the request then reaches the connector bare, escalates, and goes back to a
   * human. That is the intended shape of an expired authority - it becomes a
   * question again, never an error the peer can read a fact out of.
   */
  async #prepareGrantAssertions(
    context: Readonly<CapabilityFollowUpContext>,
    requests: readonly ConnectorResourceRequest[],
    held: ReadonlyMap<string, HeldCapabilityGrant>,
    route: Readonly<ResolvedCapabilityRoute>,
  ): Promise<PreparedGrantAssertions> {
    const grants: AssertedGrant[] = [];
    const redeemedGrantByResource = new Map<string, string>();
    const spentGrantIds: string[] = [];
    for (const item of requests) {
      if (item.kind !== "resource") continue;
      const grant = held.get(item.resourceId);
      if (!grant) continue;
      let authorized: AuthorizedCapabilityRoute;
      try {
        authorized = await this.#authorization.authorizeRoute({
          authenticatedUserId: context.peerUserId,
          ownerUserId: context.ownerUserId,
          githubRepositoryId: context.githubRepositoryId,
          conversationId: context.conversationId,
          taskId: context.taskId,
          grantId: grant.grantId,
          resourceId: item.resourceId,
          operation: "read",
        });
      } catch (error) {
        if (
          error instanceof CapabilityRouteAuthorizationError &&
          error.code === "CAPABILITY_ROUTE_FORBIDDEN"
        ) {
          continue;
        }
        throw error;
      }
      // The cloud must never hand a grant authorized for one machine to a
      // different machine. If the owner's binding moved, this round is refused
      // outright rather than routed to whoever is holding the socket now.
      if (authorized.ownerRuntimeBindingId !== route.ownerRuntimeBindingId) {
        throw new CapabilityFollowUpError("CAPABILITY_BINDING_MISMATCH");
      }

      // Redeem before asking the connector to read. The database row lock is
      // the concurrency boundary for Allow once: only the winner is permitted
      // to put the grant on a resource-exchange envelope. An unavailable or
      // expired redemption therefore turns into a bare request and can never
      // accompany delivered bytes.
      const redemption = await this.#grants.consumeGrant({
        grantId: grant.grantId,
        ownerUserId: context.ownerUserId,
        peerUserId: context.peerUserId,
        resourceId: item.resourceId,
      });
      if (redemption.outcome === "unavailable" || redemption.outcome === "expired") {
        spentGrantIds.push(grant.grantId);
        continue;
      }
      if (
        (authorized.grantMode === "once" &&
          (redemption.outcome !== "consumed" || redemption.mode !== "once")) ||
        (authorized.grantMode === "task" &&
          (redemption.outcome !== "reusable" || redemption.mode !== "task"))
      ) {
        throw new CapabilityFollowUpError("CAPABILITY_GRANT_STATE_MISMATCH");
      }
      if (redemption.outcome === "consumed") spentGrantIds.push(grant.grantId);
      grants.push({
        grantId: authorized.grantId,
        resourceId: authorized.resourceId,
        operation: authorized.operation,
        mode: authorized.grantMode,
        expiresAt: authorized.grantExpiresAt,
      });
      redeemedGrantByResource.set(item.resourceId, grant.grantId);
    }
    return { grants, redeemedGrantByResource, spentGrantIds };
  }

  /**
   * Reads the connector's answer, position by position.
   *
   * Outcome n answers request n. Nothing is matched by resource identifier,
   * because a mismatched pairing would put one file's bytes under another
   * file's authority.
   */
  async #collect(
    context: Readonly<CapabilityFollowUpContext>,
    requests: readonly ConnectorResourceRequest[],
    prepared: Readonly<PreparedGrantAssertions>,
    response: Readonly<ResourceExchangeResponse>,
    round: number,
  ): Promise<CapabilityFollowUpOutcome> {
    const delivered: DeliveredResource[] = [];
    const queued: QueuedScopeRequest[] = [];
    const spentGrantIds = [...prepared.spentGrantIds];
    let pendingWithoutCandidate = 0;
    let refused = 0;

    for (const [index, outcome] of response.outcomes.entries()) {
      const item = requests[index];
      if (!item) break;

      if (outcome.status === "refused") {
        refused += 1;
        continue;
      }

      if (outcome.status === "pending_approval") {
        // No candidate means the owner's machine found nothing it was willing
        // to name. Queuing here would invent a question about a file that may
        // not exist, so the peer simply waits and learns nothing.
        if (!outcome.candidate) {
          pendingWithoutCandidate += 1;
          continue;
        }
        const requestedHint = item.kind === "hint" ? item.hint : null;
        const result = await this.#scope.queueScopeRequest({
          taskId: context.taskId,
          ownerUserId: context.ownerUserId,
          peerUserId: context.peerUserId,
          requestedHint,
          requestedReason: item.reason,
          candidateResourceId: outcome.candidate.resourceId,
          resourceDisplayLabel: outcome.candidate.resourceDisplayLabel,
        });
        queued.push({
          candidateResourceId: outcome.candidate.resourceId,
          resourceDisplayLabel: outcome.candidate.resourceDisplayLabel,
          requestedHint,
          requestedReason: item.reason,
          outcome: result,
        });
        continue;
      }

      // A connector response is untrusted. Only a resource whose grant was
      // successfully redeemed before dispatch may contribute bytes to the
      // peer's result. This also prevents a stale or compromised connector
      // from turning a bare escalation request into content.
      if (
        item.kind !== "resource" ||
        outcome.resourceId !== item.resourceId ||
        !prepared.redeemedGrantByResource.has(outcome.resourceId)
      ) {
        refused += 1;
        continue;
      }
      delivered.push({
        resourceId: outcome.resourceId,
        content: outcome.content,
        truncated: outcome.truncated,
        byteLength: outcome.audit.byteLength,
      });
    }

    return {
      outcome: "completed",
      round,
      delivered,
      queued,
      pendingWithoutCandidate,
      refused,
      spentGrantIds,
    };
  }
}

interface PreparedGrantAssertions {
  grants: AssertedGrant[];
  redeemedGrantByResource: ReadonlyMap<string, string>;
  spentGrantIds: string[];
}

/**
 * Collapses identical asks (build plan 8.7).
 *
 * Two requests for the same file are one question for a human, however many
 * times the agent phrased it. The reason is not part of the identity: an agent
 * that reworded itself must not be able to buy a second slot in the batch.
 */
function dedupe(
  requests: readonly ConnectorResourceRequest[],
): ConnectorResourceRequest[] {
  const seen = new Set<string>();
  const unique: ConnectorResourceRequest[] = [];
  for (const item of requests) {
    const key =
      item.kind === "resource" ? "r:" + item.resourceId : "h:" + item.hint;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}
