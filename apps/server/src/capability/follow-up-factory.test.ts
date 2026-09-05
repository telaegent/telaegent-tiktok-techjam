/**
 * The assembled loop (build plan 8).
 *
 * Every part of the loop was reachable on its own and covered on its own. What
 * was never checked is that they are wired to each other: that the task the
 * record opens is the task the round is spent on, that the route the batch
 * travels is derived from that same task, and that the bytes the connector
 * returns reach the caller.
 *
 * A wiring mistake here is invisible from every unit test and total in the
 * product, so this drives the real composition and stubs only the two edges:
 * the authorization database and the connector transport.
 */

import { describe, expect, it, vi } from "vitest";

import type { CapabilityScopeRequestRepository } from "../authorization/capability-scope-requests.js";
import type { CapabilityRouteAuthorizationSnapshot } from "../authorization/capability-types.js";
import type { ConnectorResourceRequest } from "../connectors/resource-exchange.js";
import { createPrivateDraftFollowUp } from "./follow-up-factory.js";
import type { CapabilityResourceRelay } from "./follow-up-coordinator.js";
import { CapabilityScopeExpansionService } from "./service.js";

const PEER = "10000000-0000-4000-8000-000000000001";
const OWNER = "20000000-0000-4000-8000-000000000002";
const CONVERSATION = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const GRANT = "50000000-0000-4000-8000-000000000005";
const MESSAGE = "60000000-0000-4000-8000-000000000006";
const BINDING = "70000000-0000-4000-8000-000000000007";
const REPOSITORY = "1345851083";
const RESOURCE = "resource_abcdefghijklmnop";
const CONTENT = "export const rotateHourly = true;";

const draft = {
  incomingMessageId: MESSAGE,
  conversationId: CONVERSATION,
  githubRepositoryId: REPOSITORY,
  // The draft's owner is the responder: the peer whose agent is asking.
  ownerUserId: PEER,
} as const;

const asks: readonly ConnectorResourceRequest[] = [
  { kind: "resource", resourceId: RESOURCE },
];

function snapshot(
  grantId: string | null,
): CapabilityRouteAuthorizationSnapshot {
  return {
    task: {
      taskId: TASK,
      projectId: "project-1",
      conversationId: CONVERSATION,
      githubRepositoryId: REPOSITORY,
      requesterUserId: OWNER,
      responderUserId: PEER,
      originSharedMessageId: MESSAGE,
      status: "active",
      createdAt: "2026-08-31T08:55:00.000Z",
      expiresAt: "2126-08-31T10:00:00.000Z",
      endedAt: null,
    },
    project: {
      projectId: "project-1",
      githubRepositoryId: REPOSITORY,
      repositoryFullName: "telaegent/telaegent",
      visibility: "private",
      defaultBranch: "main",
      status: "active",
    },
    conversation: {
      conversationId: CONVERSATION,
      projectId: "project-1",
      participantUserIds: [PEER, OWNER],
      status: "active",
    },
    requesterMembership: {
      projectId: "project-1",
      userId: PEER,
      status: "active",
      joinedAt: "2026-08-30T00:00:00.000Z",
    },
    ownerMembership: {
      projectId: "project-1",
      userId: OWNER,
      status: "active",
      joinedAt: "2026-08-30T00:00:00.000Z",
    },
    projectConnection: {
      projectConnectionId: "connection-1",
      projectId: "project-1",
      requesterUserId: PEER,
      recipientUserId: OWNER,
      status: "connected",
      requestedAt: "2026-08-30T00:00:00.000Z",
      acceptedAt: "2026-08-30T00:01:00.000Z",
      revokedAt: null,
    },
    ownerRuntimeBinding: {
      runtimeBindingId: BINDING,
      userId: OWNER,
      projectId: "project-1",
      githubRepositoryId: REPOSITORY,
      status: "ready",
    },
    grant:
      grantId === null
        ? null
        : {
            grantId,
            taskId: TASK,
            ownerUserId: OWNER,
            peerUserId: PEER,
            resourceId: RESOURCE,
            operation: "read",
            mode: "task",
            status: "active",
            grantedByUserId: OWNER,
            grantedAt: "2026-08-31T08:56:00.000Z",
            expiresAt: "2126-08-31T09:55:00.000Z",
            consumedAt: null,
            revokedAt: null,
          },
  };
}

function scopeRepository(): CapabilityScopeRequestRepository {
  return {
    recordScopeRequest: async () => ({ outcome: "unavailable" }),
    decideScopeRequest: async () => ({ outcome: "unavailable" }),
    listPendingScopeRequests: async () => [],
    beginFollowUpRound: async () => ({ outcome: "began", round: 1 }),
  };
}

function build(
  overrides: Readonly<{
    openCollaborationTask?: () => Promise<unknown>;
    scope?: CapabilityScopeRequestRepository;
  }> = {},
) {
  const exchangeResources = vi.fn(async () => ({
    requestId: "80000000-0000-4000-8000-000000000008",
    outcomes: [
      {
        status: "delivered" as const,
        resourceId: RESOURCE,
        content: CONTENT,
        truncated: false,
        audit: {
          resourceId: RESOURCE,
          taskId: TASK,
          recipientUserId: PEER,
          byteLength: CONTENT.length,
          contentSha256: "a".repeat(64),
          authorizationMode: "task" as const,
          truncated: false,
          deliveredAt: "2026-08-31T09:00:00.000Z",
        },
      },
    ],
  }));
  const authorization = {
    fetchCapabilityRouteAuthorizationSnapshot: vi.fn(
      async (query: { grantId: string | null }) => snapshot(query.grantId),
    ),
    consumeCapabilityGrant: vi.fn(async () => ({
      outcome: "reusable",
      mode: "task" as const,
    })),
    listTaskCapabilityGrants: vi.fn(async () => ({
      outcome: "listed",
      grants: [{ grantId: GRANT, resourceId: RESOURCE }],
    })),
    openCollaborationTask: vi.fn(
      overrides.openCollaborationTask ??
        (async () => ({
          outcome: "opened",
          taskId: TASK,
          conversationId: CONVERSATION,
          githubRepositoryId: REPOSITORY,
          requesterUserId: OWNER,
          responderUserId: PEER,
          expiresAt: "2126-08-31T10:00:00.000Z",
        })),
    ),
    endCollaborationTask: vi.fn(async () => ({ outcome: "unavailable" })),
  };
  const followUp = createPrivateDraftFollowUp({
    authorization: authorization as never,
    relay: { exchangeResources } as unknown as CapabilityResourceRelay,
    scope: new CapabilityScopeExpansionService({
      repository: overrides.scope ?? scopeRepository(),
    }),
  });
  return { followUp, authorization, exchangeResources };
}

describe("the composed capability loop", () => {
  it("carries a question to a collaborator's machine and brings the bytes back", async () => {
    const { followUp, authorization, exchangeResources } = build();

    await expect(followUp.run(draft, asks)).resolves.toEqual([
      { resourceId: RESOURCE, content: CONTENT, truncated: false },
    ]);

    // The task is opened from the crossing message alone. Nothing the draft
    // claimed about its own scope was sent.
    expect(authorization.openCollaborationTask).toHaveBeenCalledWith(
      {
        taskId: expect.any(String),
        originSharedMessageId: MESSAGE,
        responderUserId: PEER,
      },
      undefined,
    );
    // The batch travels to the binding the record named, under the task the
    // record opened, asserting only the grant the ledger already held.
    expect(exchangeResources).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: TASK,
        connectorBindingId: BINDING,
        peerUserId: PEER,
        grants: [expect.objectContaining({ grantId: GRANT, resourceId: RESOURCE })],
      }),
    );
  });

  it("asks nobody anything when the record will not open a task", async () => {
    const { followUp, exchangeResources } = build({
      openCollaborationTask: async () => ({ outcome: "unavailable" }),
    });

    // A message that does not exist, a closed conversation and two people who
    // are not both in it are one answer here, and none of them travels.
    await expect(followUp.run(draft, asks)).resolves.toEqual([]);
    expect(exchangeResources).not.toHaveBeenCalled();
  });

  it("delivers nothing once the task has spent its rounds", async () => {
    const { followUp, exchangeResources } = build({
      scope: {
        ...scopeRepository(),
        beginFollowUpRound: async () => ({ outcome: "exhausted", round: 5 }),
      },
    });

    await expect(followUp.run(draft, asks)).resolves.toEqual([]);
    expect(exchangeResources).not.toHaveBeenCalled();
  });
});
