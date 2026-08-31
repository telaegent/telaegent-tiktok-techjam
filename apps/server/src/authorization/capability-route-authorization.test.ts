import { describe, expect, it, vi } from "vitest";
import type { CapabilityRouteAuthorizationRepository } from "./capability-repository.js";
import {
  CapabilityRouteAuthorizationError,
  CapabilityRouteAuthorizationService,
} from "./capability-route-authorization.js";
import type {
  AuthorizeCapabilityRouteInput,
  CapabilityRouteAuthorizationSnapshot,
  ResolveCapabilityRouteInput,
} from "./capability-types.js";

const NOW = "2026-08-31T09:00:00.000Z";
const input: AuthorizeCapabilityRouteInput = {
  authenticatedUserId: "10000000-0000-4000-8000-000000000001",
  ownerUserId: "20000000-0000-4000-8000-000000000002",
  githubRepositoryId: "1345851083",
  conversationId: "30000000-0000-4000-8000-000000000003",
  taskId: "40000000-0000-4000-8000-000000000004",
  grantId: "50000000-0000-4000-8000-000000000005",
  resourceId: "resource_abcdefghijklmnop",
  operation: "read",
};

function snapshot(): CapabilityRouteAuthorizationSnapshot {
  return {
    task: {
      taskId: input.taskId,
      projectId: "project-1",
      conversationId: input.conversationId,
      githubRepositoryId: input.githubRepositoryId,
      requesterUserId: input.authenticatedUserId,
      responderUserId: input.ownerUserId,
      originSharedMessageId: "60000000-0000-4000-8000-000000000006",
      status: "active",
      createdAt: "2026-08-31T08:55:00.000Z",
      expiresAt: "2026-08-31T10:00:00.000Z",
      endedAt: null,
    },
    project: {
      projectId: "project-1",
      githubRepositoryId: input.githubRepositoryId,
      repositoryFullName: "telaegent/telaegent",
      visibility: "private",
      defaultBranch: "main",
      status: "active",
    },
    conversation: {
      conversationId: input.conversationId,
      projectId: "project-1",
      participantUserIds: [input.authenticatedUserId, input.ownerUserId],
      status: "active",
    },
    requesterMembership: {
      projectId: "project-1",
      userId: input.authenticatedUserId,
      status: "active",
      joinedAt: "2026-08-30T00:00:00.000Z",
    },
    ownerMembership: {
      projectId: "project-1",
      userId: input.ownerUserId,
      status: "active",
      joinedAt: "2026-08-30T00:00:00.000Z",
    },
    projectConnection: {
      projectConnectionId: "connection-1",
      projectId: "project-1",
      requesterUserId: input.authenticatedUserId,
      recipientUserId: input.ownerUserId,
      status: "connected",
      requestedAt: "2026-08-30T00:00:00.000Z",
      acceptedAt: "2026-08-30T00:01:00.000Z",
      revokedAt: null,
    },
    ownerRuntimeBinding: {
      runtimeBindingId: "70000000-0000-4000-8000-000000000007",
      userId: input.ownerUserId,
      projectId: "project-1",
      githubRepositoryId: input.githubRepositoryId,
      status: "ready",
    },
    grant: {
      grantId: input.grantId,
      taskId: input.taskId,
      ownerUserId: input.ownerUserId,
      peerUserId: input.authenticatedUserId,
      resourceId: input.resourceId,
      operation: "read",
      mode: "task",
      status: "active",
      grantedByUserId: input.ownerUserId,
      grantedAt: "2026-08-31T08:56:00.000Z",
      expiresAt: "2026-08-31T09:55:00.000Z",
      consumedAt: null,
      revokedAt: null,
    },
  };
}

function harness(value: CapabilityRouteAuthorizationSnapshot = snapshot()) {
  const load = vi.fn(async () => structuredClone(value));
  const repository: CapabilityRouteAuthorizationRepository = {
    loadCapabilityRouteAuthorizationSnapshot: load,
  };
  const service = new CapabilityRouteAuthorizationService(
    repository,
    { repositoryReadTimeoutMs: 500 },
    () => new Date(NOW),
  );
  return { service, load };
}

describe("CapabilityRouteAuthorizationService", () => {
  it("routes only the exact active read grant and requires connector authorization", async () => {
    const { service, load } = harness();

    await expect(service.authorizeRoute(input)).resolves.toEqual({
      taskId: input.taskId,
      grantId: input.grantId,
      resourceId: input.resourceId,
      operation: "read",
      ownerUserId: input.ownerUserId,
      peerUserId: input.authenticatedUserId,
      githubRepositoryId: input.githubRepositoryId,
      conversationId: input.conversationId,
      ownerRuntimeBindingId: "70000000-0000-4000-8000-000000000007",
      grantMode: "task",
      grantExpiresAt: "2026-08-31T09:55:00.000Z",
      requiresLocalAuthorization: true,
    });
    expect(load).toHaveBeenCalledOnce();
    expect(JSON.stringify(await service.authorizeRoute(input))).not.toMatch(
      /workspace|path|content|credential|session/i,
    );
  });

  it.each([
    ["a different task", (state: CapabilityRouteAuthorizationSnapshot) => {
      state.task!.taskId = "other-task";
    }],
    ["a different peer", (state: CapabilityRouteAuthorizationSnapshot) => {
      state.grant!.peerUserId = "another-user";
    }],
    ["a different resource", (state: CapabilityRouteAuthorizationSnapshot) => {
      state.grant!.resourceId = "resource_qrstuvwxyzabcdef";
    }],
    ["a completed task", (state: CapabilityRouteAuthorizationSnapshot) => {
      state.task!.status = "completed";
      state.task!.endedAt = NOW;
    }],
    ["a revoked grant", (state: CapabilityRouteAuthorizationSnapshot) => {
      state.grant!.status = "revoked";
      state.grant!.revokedAt = NOW;
    }],
    ["a consumed one-shot grant", (state: CapabilityRouteAuthorizationSnapshot) => {
      state.grant!.mode = "once";
      state.grant!.status = "consumed";
      state.grant!.consumedAt = NOW;
    }],
    ["a stale owner binding", (state: CapabilityRouteAuthorizationSnapshot) => {
      state.ownerRuntimeBinding = {
        ...state.ownerRuntimeBinding!,
        status: "revoked",
      };
    }],
  ])("fails closed for %s", async (_label, mutate) => {
    const state = snapshot();
    mutate(state);
    const { service } = harness(state);

    await expect(service.authorizeRoute(input)).rejects.toMatchObject({
      code: "CAPABILITY_ROUTE_FORBIDDEN",
    });
  });

  it("rejects scope expansion and write requests before loading any facts", async () => {
    const { service, load } = harness();

    await expect(service.authorizeRoute({
      ...input,
      resourceId: "src/settings.ts",
    })).rejects.toMatchObject({ reason: "invalid_request" });
    await expect(service.authorizeRoute({
      ...input,
      operation: "write" as never,
    })).rejects.toMatchObject({ reason: "invalid_request" });
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects task and grant expiry independently", async () => {
    const expiredTask = snapshot();
    expiredTask.task!.expiresAt = "2026-08-31T08:59:59.000Z";
    await expect(harness(expiredTask).service.authorizeRoute(input)).rejects.toMatchObject({
      reason: "task_expired",
    });

    const expiredGrant = snapshot();
    expiredGrant.grant!.expiresAt = "2026-08-31T08:59:59.000Z";
    await expect(harness(expiredGrant).service.authorizeRoute(input)).rejects.toMatchObject({
      reason: "grant_expired",
    });
  });

  it("collapses repository failures without leaking their details", async () => {
    const repository: CapabilityRouteAuthorizationRepository = {
      async loadCapabilityRouteAuthorizationSnapshot() {
        throw new Error("select failed beside C:\\Users\\owner\\secret.txt");
      },
    };
    const service = new CapabilityRouteAuthorizationService(
      repository,
      { repositoryReadTimeoutMs: 500 },
      () => new Date(NOW),
    );

    const error = await service.authorizeRoute(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CapabilityRouteAuthorizationError);
    expect(error).toMatchObject({
      code: "CAPABILITY_ROUTE_AUTHORIZATION_UNAVAILABLE",
    });
    expect(String(error) + JSON.stringify(error)).not.toContain("secret.txt");
  });
});

describe("resolving a route for an ask with no grant behind it", () => {
  const query: ResolveCapabilityRouteInput = {
    authenticatedUserId: input.authenticatedUserId,
    ownerUserId: input.ownerUserId,
    githubRepositoryId: input.githubRepositoryId,
    conversationId: input.conversationId,
    taskId: input.taskId,
  };

  it("names the owner's connector and nothing that resembles a permission", async () => {
    const { service, load } = harness();

    await expect(service.resolveRoute(query)).resolves.toEqual({
      taskId: input.taskId,
      ownerUserId: input.ownerUserId,
      peerUserId: input.authenticatedUserId,
      githubRepositoryId: input.githubRepositoryId,
      conversationId: input.conversationId,
      ownerRuntimeBindingId: "70000000-0000-4000-8000-000000000007",
      taskExpiresAt: "2026-08-31T10:00:00.000Z",
      requiresLocalAuthorization: true,
    });
    // No grant is looked up, because there is none to reuse.
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: null }),
      expect.anything(),
    );
  });

  it("resolves nothing for a task with no grant in it at all", async () => {
    const state = snapshot();
    state.grant = null;
    const { service } = harness(state);

    // The whole point: a first ask has no grant, and must still route.
    await expect(service.resolveRoute(query)).resolves.toMatchObject({
      ownerRuntimeBindingId: "70000000-0000-4000-8000-000000000007",
    });
  });

  it.each([
    ["a revoked connection", (state: CapabilityRouteAuthorizationSnapshot) => {
      state.projectConnection!.status = "revoked";
    }],
    ["a connector that is not ready", (state: CapabilityRouteAuthorizationSnapshot) => {
      state.ownerRuntimeBinding!.status = "pending";
    }],
    ["a task in another repository", (state: CapabilityRouteAuthorizationSnapshot) => {
      state.task!.githubRepositoryId = "1345851099";
    }],
    ["a cancelled task", (state: CapabilityRouteAuthorizationSnapshot) => {
      state.task!.status = "cancelled";
      state.task!.endedAt = NOW;
    }],
    ["a membership that lapsed", (state: CapabilityRouteAuthorizationSnapshot) => {
      state.ownerMembership!.status = "removed";
    }],
  ])("refuses to route around %s", async (_label, mutate) => {
    const state = snapshot();
    mutate(state);
    const { service } = harness(state);

    // Every scope check an authorized route makes is made here too: a batch
    // that reaches the wrong machine is a leak whether or not it comes back.
    await expect(service.resolveRoute(query)).rejects.toMatchObject({
      code: "CAPABILITY_ROUTE_FORBIDDEN",
    });
  });
});
