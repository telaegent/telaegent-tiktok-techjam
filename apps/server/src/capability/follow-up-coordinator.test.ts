import { describe, expect, it, vi } from "vitest";
import type { CapabilityGrantRepository } from "../authorization/capability-grants.js";
import { CapabilityRouteAuthorizationError } from "../authorization/capability-route-authorization.js";
import type {
  AuthorizedCapabilityRoute,
  ResolvedCapabilityRoute,
} from "../authorization/capability-types.js";
import type { CapabilityScopeRequestRepository } from "../authorization/capability-scope-requests.js";
import type {
  ConnectorResourceRequest,
  ResourceExchangeResponse,
} from "../connectors/resource-exchange.js";
import {
  CapabilityFollowUpCoordinator,
  CapabilityFollowUpError,
  type CapabilityFollowUpContext,
  type CapabilityResourceRelay,
  type CapabilityRouteAuthorizer,
} from "./follow-up-coordinator.js";
import { CapabilityScopeExpansionService } from "./service.js";

const ownerId = "10000000-0000-4000-8000-000000000001";
const peerId = "10000000-0000-4000-8000-000000000002";
const taskId = "20000000-0000-4000-8000-000000000001";
const conversationId = "30000000-0000-4000-8000-000000000001";
const scopeRequestId = "40000000-0000-4000-8000-000000000001";
const grantId = "50000000-0000-4000-8000-000000000001";
const bindingId = "60000000-0000-4000-8000-000000000001";
const requestId = "70000000-0000-4000-8000-000000000001";
const resourceId = `resource_${"a".repeat(24)}`;
const otherResourceId = `resource_${"b".repeat(24)}`;

const context: CapabilityFollowUpContext = {
  taskId,
  conversationId,
  githubRepositoryId: "1345851084",
  ownerUserId: ownerId,
  peerUserId: peerId,
};

const askForHeld: ConnectorResourceRequest = {
  kind: "resource",
  resourceId,
  reason: "the caller needs the settings it was already shown",
};

const askByHint: ConnectorResourceRequest = {
  kind: "hint",
  hint: "src/settings.ts",
  reason: "the landing page imports it",
};

const route: AuthorizedCapabilityRoute = {
  taskId,
  grantId,
  resourceId,
  operation: "read",
  ownerUserId: ownerId,
  peerUserId: peerId,
  githubRepositoryId: "1345851084",
  conversationId,
  ownerRuntimeBindingId: bindingId,
  grantMode: "once",
  grantExpiresAt: "2026-08-31T10:40:00.000Z",
  requiresLocalAuthorization: true,
};

const resolved: ResolvedCapabilityRoute = {
  taskId,
  ownerUserId: ownerId,
  peerUserId: peerId,
  githubRepositoryId: "1345851084",
  conversationId,
  ownerRuntimeBindingId: bindingId,
  taskExpiresAt: "2026-08-31T10:40:00.000Z",
  requiresLocalAuthorization: true,
};

function delivered(content: string): ResourceExchangeResponse["outcomes"][number] {
  return {
    status: "delivered",
    resourceId,
    content,
    truncated: false,
    audit: {
      resourceId,
      taskId,
      recipientUserId: peerId,
      byteLength: Buffer.byteLength(content),
      contentSha256: "a".repeat(64),
      authorizationMode: "once",
      truncated: false,
      deliveredAt: "2026-08-31T09:41:00.000Z",
    },
  };
}

/** Refuses everything unless a test opts one call in. */
function scopeRepository(
  overrides: Partial<CapabilityScopeRequestRepository> = {},
): CapabilityScopeRequestRepository {
  return {
    recordScopeRequest: async () => ({ outcome: "recorded", scopeRequestId }),
    decideScopeRequest: async () => ({ outcome: "unavailable" }),
    listPendingScopeRequests: async () => [],
    beginFollowUpRound: async () => ({ outcome: "started", round: 1 }),
    ...overrides,
  };
}

function build(parts: {
  scope?: Partial<CapabilityScopeRequestRepository>;
  authorizeRoute?: CapabilityRouteAuthorizer["authorizeRoute"];
  resolveRoute?: CapabilityRouteAuthorizer["resolveRoute"];
  exchangeResources?: CapabilityResourceRelay["exchangeResources"];
  consumeGrant?: CapabilityGrantRepository["consumeGrant"];
  listTaskGrants?: CapabilityGrantRepository["listTaskGrants"];
} = {}) {
  const authorizeRoute = vi.fn<CapabilityRouteAuthorizer["authorizeRoute"]>(
    parts.authorizeRoute ?? (async () => route),
  );
  const resolveRoute = vi.fn<CapabilityRouteAuthorizer["resolveRoute"]>(
    parts.resolveRoute ?? (async () => resolved),
  );
  const exchangeResources = vi.fn<CapabilityResourceRelay["exchangeResources"]>(
    parts.exchangeResources ?? (async () => ({ requestId, outcomes: [] })),
  );
  const consumeGrant = vi.fn<CapabilityGrantRepository["consumeGrant"]>(
    parts.consumeGrant ?? (async () => ({ outcome: "consumed", mode: "once" })),
  );
  // The ledger is read, not asserted: by default this peer already holds the
  // one grant a human approved earlier in this same task.
  const listTaskGrants = vi.fn<CapabilityGrantRepository["listTaskGrants"]>(
    parts.listTaskGrants ??
      (async () => ({ outcome: "listed", grants: [{ grantId, resourceId }] })),
  );
  const coordinator = new CapabilityFollowUpCoordinator({
    scope: new CapabilityScopeExpansionService({
      repository: scopeRepository(parts.scope),
      newId: () => scopeRequestId,
    }),
    authorization: { authorizeRoute, resolveRoute },
    relay: { exchangeResources },
    grants: { consumeGrant, listTaskGrants },
    newRequestId: () => requestId,
  });
  return {
    coordinator,
    authorizeRoute,
    resolveRoute,
    exchangeResources,
    consumeGrant,
    listTaskGrants,
  };
}

describe("capability follow-up coordinator", () => {
  it("spends a round before it contacts anyone, and stops when the budget is gone", async () => {
    const { coordinator, exchangeResources, authorizeRoute } = build({
      scope: { beginFollowUpRound: async () => ({ outcome: "exhausted", round: 5 }) },
    });

    const result = await coordinator.runRound(context, [askByHint]);

    // Build plan 8.7: five rounds, then the loop stops on its own. Nothing
    // reached the other machine, so an exhausted loop cannot even be observed
    // by the owner's connector.
    expect(result).toEqual({ outcome: "exhausted", round: 5 });
    expect(exchangeResources).not.toHaveBeenCalled();
    expect(authorizeRoute).not.toHaveBeenCalled();
  });

  it("does not route a batch for a collaboration that has ended", async () => {
    const { coordinator, exchangeResources } = build({
      scope: { beginFollowUpRound: async () => ({ outcome: "task_unavailable" }) },
    });

    const result = await coordinator.runRound(context, [askByHint]);

    expect(result).toEqual({ outcome: "task_unavailable" });
    expect(exchangeResources).not.toHaveBeenCalled();
  });

  it("spends nothing when the turn asked for nothing", async () => {
    const beginFollowUpRound = vi.fn<
      CapabilityScopeRequestRepository["beginFollowUpRound"]
    >(async () => ({ outcome: "started", round: 1 }));
    const { coordinator, exchangeResources } = build({ scope: { beginFollowUpRound } });

    const result = await coordinator.runRound(context, []);

    expect(result).toMatchObject({ outcome: "completed", round: 0, delivered: [] });
    expect(beginFollowUpRound).not.toHaveBeenCalled();
    expect(exchangeResources).not.toHaveBeenCalled();
  });

  it("asserts a held grant, routes the batch, and brings the bytes back", async () => {
    const order: string[] = [];
    const { coordinator, exchangeResources, authorizeRoute, consumeGrant } = build({
      consumeGrant: async () => {
        order.push("consume");
        return { outcome: "consumed", mode: "once" };
      },
      exchangeResources: async () => {
        order.push("exchange");
        return { requestId, outcomes: [delivered("export const a = 1;")] };
      },
    });

    const result = await coordinator.runRound(context, [askForHeld]);

    expect(authorizeRoute).toHaveBeenCalledWith({
      authenticatedUserId: peerId,
      ownerUserId: ownerId,
      githubRepositoryId: "1345851084",
      conversationId,
      taskId,
      grantId,
      resourceId,
      operation: "read",
    });
    expect(exchangeResources).toHaveBeenCalledWith({
      requestId,
      taskId,
      taskExpiresAt: "2026-08-31T10:40:00.000Z",
      connectorBindingId: bindingId,
      peerUserId: peerId,
      requests: [askForHeld],
      grants: [
        {
          grantId,
          resourceId,
          operation: "read",
          mode: "once",
          expiresAt: "2026-08-31T10:40:00.000Z",
        },
      ],
    });
    expect(result).toMatchObject({
      outcome: "completed",
      round: 1,
      delivered: [{ resourceId, content: "export const a = 1;", truncated: false }],
      // Allow once means once: the grant is redeemed before the read, and the
      // caller is told to drop it before it can be asserted a second time.
      spentGrantIds: [grantId],
    });
    expect(order).toEqual(["consume", "exchange"]);
    expect(consumeGrant).toHaveBeenCalledWith({
      grantId,
      ownerUserId: ownerId,
      peerUserId: peerId,
      resourceId,
    });
  });

  it("keeps a task-scoped grant alive across rounds", async () => {
    const { coordinator } = build({
      authorizeRoute: async () => ({ ...route, grantMode: "task" }),
      exchangeResources: async () => ({ requestId, outcomes: [delivered("hello")] }),
      consumeGrant: async () => ({ outcome: "reusable", mode: "task" }),
    });

    const result = await coordinator.runRound(context, [askForHeld]);

    // Allow for this task is the one authority that survives redemption.
    expect(result).toMatchObject({ spentGrantIds: [] });
  });

  it("never delivers bytes when grant redemption is unavailable", async () => {
    const { coordinator, exchangeResources } = build({
      consumeGrant: async () => ({ outcome: "unavailable" }),
      // Treat the connector as untrusted: even if it incorrectly returns bytes
      // for the now-bare request, the coordinator must discard them.
      exchangeResources: async () => ({ requestId, outcomes: [delivered("secret")] }),
    });

    const result = await coordinator.runRound(context, [askForHeld]);

    expect(exchangeResources).toHaveBeenCalledWith(
      expect.objectContaining({ grants: [] }),
    );
    expect(result).toMatchObject({
      delivered: [],
      refused: 1,
      spentGrantIds: [grantId],
    });
  });

  it("serializes racing Allow once redemptions before either connector read", async () => {
    let calls = 0;
    const { coordinator } = build({
      consumeGrant: async () =>
        ++calls === 1
          ? { outcome: "consumed", mode: "once" }
          : { outcome: "unavailable" },
      exchangeResources: async (request) => ({
        requestId,
        outcomes: request.grants.length === 1
          ? [delivered("winner")]
          : [delivered("loser must be discarded")],
      }),
    });

    const [first, second] = await Promise.all([
      coordinator.runRound(context, [askForHeld]),
      coordinator.runRound(context, [askForHeld]),
    ]);

    expect(first).toMatchObject({ delivered: [{ content: "winner" }] });
    expect(second).toMatchObject({ delivered: [], refused: 1 });
  });

  it("puts a named candidate in front of the owning human", async () => {
    const recordScopeRequest = vi.fn<
      CapabilityScopeRequestRepository["recordScopeRequest"]
    >(async () => ({ outcome: "recorded", scopeRequestId }));
    const { coordinator } = build({
      scope: { recordScopeRequest },
      exchangeResources: async () => ({
        requestId,
        outcomes: [
          {
            status: "pending_approval",
            request: askByHint,
            candidate: {
              resourceId: otherResourceId,
              resourceDisplayLabel: "src/settings.ts",
            },
          },
        ],
      }),
    });

    const result = await coordinator.runRound(context, [askByHint]);

    // The human sees the peer's own words, the opaque identifier, and a safe
    // project-relative label derived by the owner's connector. The canonical
    // local path never enters the cloud.
    expect(recordScopeRequest).toHaveBeenCalledWith(
      {
        scopeRequestId,
        taskId,
        ownerUserId: ownerId,
        peerUserId: peerId,
        requestedHint: "src/settings.ts",
        resourceDisplayLabel: "src/settings.ts",
        requestedReason: "the landing page imports it",
        candidateResourceId: otherResourceId,
      },
      undefined,
    );
    expect(result).toMatchObject({
      queued: [
        {
          candidateResourceId: otherResourceId,
          requestedHint: "src/settings.ts",
          resourceDisplayLabel: "src/settings.ts",
          requestedReason: "the landing page imports it",
          outcome: { outcome: "recorded", scopeRequestId },
        },
      ],
      delivered: [],
    });
  });

  it("asks nobody anything when the owner's machine named no candidate", async () => {
    const recordScopeRequest = vi.fn<
      CapabilityScopeRequestRepository["recordScopeRequest"]
    >(async () => ({ outcome: "recorded", scopeRequestId }));
    const { coordinator } = build({
      scope: { recordScopeRequest },
      exchangeResources: async () => ({
        requestId,
        outcomes: [{ status: "pending_approval", request: askByHint }],
      }),
    });

    const result = await coordinator.runRound(context, [askByHint]);

    // A file that is missing, a file that is screened out as a secret, and a
    // file that merely awaits a person all look like this. Queuing a question
    // here would tell the peer which of the three it hit.
    expect(recordScopeRequest).not.toHaveBeenCalled();
    expect(result).toMatchObject({ pendingWithoutCandidate: 1, queued: [] });
  });

  it("counts a refusal without learning why", async () => {
    const { coordinator } = build({
      exchangeResources: async () => ({ requestId, outcomes: [{ status: "refused" }] }),
    });

    const result = await coordinator.runRound(context, [askByHint]);

    expect(result).toMatchObject({ refused: 1, delivered: [], queued: [] });
  });

  it("collapses an ask the agent repeated into one question", async () => {
    const { coordinator, exchangeResources } = build();

    await coordinator.runRound(context, [
      askByHint,
      { kind: "hint", hint: "src/settings.ts", reason: "and again, differently worded" },
      askForHeld,
    ]);

    // Rewording does not buy a second slot in the batch, nor a second prompt
    // for the human who has to answer it.
    expect(exchangeResources).toHaveBeenCalledWith(
      expect.objectContaining({ requests: [askByHint, askForHeld] }),
    );
  });

  it("refuses to route a grant authorized for a different machine", async () => {
    const { coordinator, exchangeResources } = build({
      authorizeRoute: async () => ({
        ...route,
        ownerRuntimeBindingId: "60000000-0000-4000-8000-00000000ffff",
      }),
    });

    await expect(coordinator.runRound(context, [askForHeld])).rejects.toBeInstanceOf(
      CapabilityFollowUpError,
    );
    // The bytes never leave the owner's machine for a connector the grant was
    // not authorized against.
    expect(exchangeResources).not.toHaveBeenCalled();
  });

  it("turns a grant that no longer authorizes anything back into a question", async () => {
    const { coordinator, exchangeResources } = build({
      authorizeRoute: async () => {
        throw new CapabilityRouteAuthorizationError(
          "CAPABILITY_ROUTE_FORBIDDEN",
          "grant_expired",
        );
      },
      exchangeResources: async () => ({
        requestId,
        outcomes: [
          {
            status: "pending_approval",
            request: askForHeld,
            candidate: { resourceId, resourceDisplayLabel: "src/known.ts" },
          },
        ],
      }),
    });

    const result = await coordinator.runRound(context, [askForHeld]);

    // The batch still goes, bare. An expired authority becomes an ask again
    // rather than an error the peer could read a fact out of.
    expect(exchangeResources).toHaveBeenCalledWith(
      expect.objectContaining({ grants: [] }),
    );
    // An escalated identifier carries no hint: the human already knows which
    // file it is, and the peer never learned a name for it.
    expect(result).toMatchObject({
      queued: [
        {
          candidateResourceId: resourceId,
          resourceDisplayLabel: "src/known.ts",
          requestedHint: null,
        },
      ],
    });
  });

  it("raises an authorization outage instead of silently reading without a grant", async () => {
    const { coordinator, exchangeResources } = build({
      authorizeRoute: async () => {
        throw new CapabilityRouteAuthorizationError(
          "CAPABILITY_ROUTE_AUTHORIZATION_UNAVAILABLE",
          "repository_read_failed",
        );
      },
    });

    await expect(coordinator.runRound(context, [askForHeld])).rejects.toBeInstanceOf(
      CapabilityRouteAuthorizationError,
    );
    expect(exchangeResources).not.toHaveBeenCalled();
  });

  it("asks the record which grants exist rather than being told", async () => {
    const { coordinator, listTaskGrants, authorizeRoute } = build();

    await coordinator.runRound(context, [askForHeld]);

    // Nothing in the context carries authority. A caller that could hand over a
    // ledger could hand over a grant nobody ever pressed.
    expect(listTaskGrants).toHaveBeenCalledWith({
      taskId,
      ownerUserId: ownerId,
      peerUserId: peerId,
    });
    expect(authorizeRoute).toHaveBeenCalledWith(
      expect.objectContaining({ grantId, resourceId }),
    );
  });

  it("asserts nothing when the ledger cannot be read", async () => {
    const { coordinator, authorizeRoute, exchangeResources } = build({
      listTaskGrants: async () => ({ outcome: "unavailable" }),
    });

    await coordinator.runRound(context, [askForHeld]);

    // Failing towards a human is the safe direction: the round is spent, the
    // batch travels bare, and the question goes back to the person who owns
    // the files instead of being answered on a guess.
    expect(authorizeRoute).not.toHaveBeenCalled();
    expect(exchangeResources).toHaveBeenCalledWith(
      expect.objectContaining({ grants: [] }),
    );
  });

  it("takes the connector it delivers to from the task, never from the caller", async () => {
    const { coordinator, resolveRoute, exchangeResources } = build();

    await coordinator.runRound(context, [askByHint]);

    // Nothing in the context names a machine. A caller that could name one
    // could name somebody else's, and a first ask carries no grant to derive
    // it from either.
    expect(resolveRoute).toHaveBeenCalledWith({
      authenticatedUserId: peerId,
      ownerUserId: ownerId,
      githubRepositoryId: "1345851084",
      conversationId,
      taskId,
    });
    expect(exchangeResources).toHaveBeenCalledWith(
      expect.objectContaining({ connectorBindingId: bindingId, grants: [] }),
    );
  });

  it("spends the round and says nothing when there is nowhere to deliver", async () => {
    const { coordinator, exchangeResources, authorizeRoute } = build({
      resolveRoute: async () => {
        throw new CapabilityRouteAuthorizationError(
          "CAPABILITY_ROUTE_FORBIDDEN",
          "project_connection_unavailable",
        );
      },
    });

    const result = await coordinator.runRound(context, [askForHeld]);

    // A revoked connection, an unready connector and a task that no longer
    // spans both people are one outcome, so a peer cannot probe for which.
    expect(result).toEqual({ outcome: "unroutable", round: 1 });
    expect(authorizeRoute).not.toHaveBeenCalled();
    expect(exchangeResources).not.toHaveBeenCalled();
  });
});
