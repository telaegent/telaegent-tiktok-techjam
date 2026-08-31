import { describe, expect, it, vi } from "vitest";
import { CapabilityRouteAuthorizationService } from "./capability-route-authorization.js";
import type { AuthorizeCapabilityRouteInput } from "./capability-types.js";
import {
  SupabaseCapabilityRepositoryError,
  SupabaseCapabilityRouteAuthorizationRepository,
  mapSupabaseCapabilityRouteSnapshot,
  type SupabaseCapabilityRouteSnapshotDto,
  type SupabaseCapabilitySnapshotClient,
} from "./supabase-capability-repository.js";

const peer = "10000000-0000-4000-8000-000000000001";
const owner = "10000000-0000-4000-8000-000000000002";
const projectId = "20000000-0000-4000-8000-000000000001";
const conversationId = "20000000-0000-4000-8000-000000000002";
const taskId = "40000000-0000-4000-8000-000000000001";
const grantId = "30000000-0000-4000-8000-000000000001";
const bindingId = "50000000-0000-4000-8000-000000000001";
const resourceId = `resource_${"a".repeat(24)}`;
const githubRepositoryId = "9223372036854775807";
const now = new Date("2026-08-31T12:00:00.000Z");

function payload(
  overrides: Partial<SupabaseCapabilityRouteSnapshotDto> = {},
): SupabaseCapabilityRouteSnapshotDto {
  return {
    task: {
      taskId,
      projectId,
      conversationId,
      githubRepositoryId,
      requesterUserId: peer,
      responderUserId: owner,
      originSharedMessageId: "60000000-0000-4000-8000-000000000001",
      status: "active",
      createdAt: "2026-08-31T11:00:00.000Z",
      expiresAt: "2026-08-31T13:00:00.000Z",
      endedAt: null,
    },
    project: {
      projectId,
      githubRepositoryId,
      repositoryFullName: "telaegent/telaegent-codejam",
      visibility: "private",
      defaultBranch: "main",
      status: "active",
    },
    conversation: {
      conversationId,
      projectId,
      participantUserIds: [peer, owner],
      status: "active",
    },
    requesterMembership: {
      projectId,
      userId: peer,
      status: "active",
      joinedAt: "2026-08-30T10:00:00.000Z",
    },
    ownerMembership: {
      projectId,
      userId: owner,
      status: "active",
      joinedAt: "2026-08-30T10:00:00.000Z",
    },
    projectConnection: {
      projectConnectionId: "70000000-0000-4000-8000-000000000001",
      projectId,
      requesterUserId: peer,
      recipientUserId: owner,
      status: "connected",
      acceptedAt: "2026-08-30T10:05:00.000Z",
      revokedAt: null,
      requestedAt: "2026-08-30T10:00:00.000Z",
    },
    ownerRuntimeBinding: {
      runtimeBindingId: bindingId,
      userId: owner,
      projectId,
      githubRepositoryId,
      status: "ready",
    },
    grant: {
      grantId,
      taskId,
      ownerUserId: owner,
      peerUserId: peer,
      resourceId,
      operation: "read",
      mode: "task",
      status: "active",
      grantedByUserId: owner,
      grantedAt: "2026-08-31T11:30:00.000Z",
      expiresAt: "2026-08-31T12:30:00.000Z",
      consumedAt: null,
      revokedAt: null,
    },
    ...overrides,
  };
}

const input: AuthorizeCapabilityRouteInput = {
  authenticatedUserId: peer,
  ownerUserId: owner,
  githubRepositoryId,
  conversationId,
  taskId,
  grantId,
  resourceId,
  operation: "read",
};

function client(
  fetchSnapshot: SupabaseCapabilitySnapshotClient["fetchCapabilityRouteAuthorizationSnapshot"],
): SupabaseCapabilitySnapshotClient {
  return { fetchCapabilityRouteAuthorizationSnapshot: fetchSnapshot };
}

describe("supabase capability route repository", () => {
  it("makes the capability route service reachable end to end", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(payload());
    const service = new CapabilityRouteAuthorizationService(
      new SupabaseCapabilityRouteAuthorizationRepository(client(fetchSnapshot)),
      { repositoryReadTimeoutMs: 5_000 },
      () => now,
    );

    const route = await service.authorizeRoute(input);

    expect(route).toEqual({
      taskId,
      grantId,
      resourceId,
      operation: "read",
      ownerUserId: owner,
      peerUserId: peer,
      githubRepositoryId,
      conversationId,
      ownerRuntimeBindingId: bindingId,
      grantMode: "task",
      grantExpiresAt: "2026-08-31T12:30:00.000Z",
      // The cloud never decides that a file may be opened.
      requiresLocalAuthorization: true,
    });
    expect(fetchSnapshot).toHaveBeenCalledWith(
      {
        peerUserId: peer,
        ownerUserId: owner,
        githubRepositoryId,
        conversationId,
        taskId,
        grantId,
      },
      expect.anything(),
    );
  });

  it("rejects a payload that claims anything but read authority", () => {
    const claimsWrite = { ...payload().grant!, operation: "write" };
    // Write or execute authority is malformed, not merely unauthorized: it must
    // be refused before any policy code can read it.
    expect(() =>
      mapSupabaseCapabilityRouteSnapshot(payload({ grant: claimsWrite as never })),
    ).toThrow(SupabaseCapabilityRepositoryError);
  });

  it("rejects an identifier the grant table itself would reject", () => {
    const grant = { ...payload().grant!, resourceId: "/etc/passwd" };
    expect(() => mapSupabaseCapabilityRouteSnapshot(payload({ grant }))).toThrow(
      SupabaseCapabilityRepositoryError,
    );
  });

  it("rejects a snapshot carrying an unexpected field", () => {
    const smuggled = { ...payload(), canonicalPath: "/home/owner/src/settings.ts" };
    // A path can never appear in a cloud snapshot, so a payload containing one
    // is invalid rather than something to ignore.
    expect(() => mapSupabaseCapabilityRouteSnapshot(smuggled)).toThrow(
      SupabaseCapabilityRepositoryError,
    );
  });

  it("rejects a conversation wider than the two peers of the loop", () => {
    const conversation = {
      ...payload().conversation!,
      participantUserIds: [peer, owner, "10000000-0000-4000-8000-000000000003", "x"],
    };
    expect(() =>
      mapSupabaseCapabilityRouteSnapshot(payload({ conversation })),
    ).toThrow(SupabaseCapabilityRepositoryError);
  });

  it("reports a transport failure as unavailable rather than invalid", async () => {
    const repository = new SupabaseCapabilityRouteAuthorizationRepository(
      client(vi.fn().mockRejectedValue(new Error("socket hang up"))),
    );
    await expect(
      repository.loadCapabilityRouteAuthorizationSnapshot(input),
    ).rejects.toMatchObject({ code: "SUPABASE_CAPABILITY_UNAVAILABLE" });
  });

  it("reports a malformed successful response as an invalid snapshot", async () => {
    const repository = new SupabaseCapabilityRouteAuthorizationRepository(
      client(vi.fn().mockResolvedValue(undefined)),
    );
    await expect(
      repository.loadCapabilityRouteAuthorizationSnapshot(input),
    ).rejects.toMatchObject({ code: "INVALID_SUPABASE_CAPABILITY_SNAPSHOT" });
  });

  it("aborts without calling the database", async () => {
    const fetchSnapshot = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const repository = new SupabaseCapabilityRouteAuthorizationRepository(
      client(fetchSnapshot),
    );
    await expect(
      repository.loadCapabilityRouteAuthorizationSnapshot(input, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it("keeps a revoked grant visible instead of hiding it as absent", () => {
    const grant = {
      ...payload().grant!,
      status: "revoked",
      revokedAt: "2026-08-31T11:45:00.000Z",
    };
    // The repository returns facts. Hiding a revoked grant would make it
    // indistinguishable from a grant that never existed, and the service could
    // no longer tell an unavailable route from an inconsistent one.
    const snapshot = mapSupabaseCapabilityRouteSnapshot(payload({ grant }));
    expect(snapshot.grant?.status).toBe("revoked");
  });
});
