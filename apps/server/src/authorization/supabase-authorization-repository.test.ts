import { describe, expect, it, vi } from "vitest";
import {
  mapSupabasePrivateRuntimeAuthorizationSnapshot,
  PrivateRuntimeAuthorizationService,
  SupabaseAuthorizationRepositoryError,
  SupabasePrivateRuntimeAuthorizationRepository,
  type AuthorizePrivateRuntimeInput,
  type SupabaseAuthorizationSnapshotClient,
  type SupabasePrivateRuntimeAuthorizationSnapshotDto,
} from "./index.js";

const input: AuthorizePrivateRuntimeInput = {
  authenticatedUserId: "user-1",
  githubRepositoryId: "1345851083",
  conversationId: "conversation-1",
};
const now = new Date("2026-08-30T12:00:00.000Z");

function validPayload(): SupabasePrivateRuntimeAuthorizationSnapshotDto {
  return {
    user: { userId: "user-1", status: "active" },
    githubConnection: {
      githubConnectionId: "github-connection-1",
      userId: "user-1",
      githubUserId: "12345",
      githubLogin: "khoa",
      status: "connected",
      connectedAt: "2026-08-30T10:00:00.000Z",
      lastVerifiedAt: "2026-08-30T11:59:00.000Z",
    },
    repositoryAccess: {
      userId: "user-1",
      githubConnectionId: "github-connection-1",
      githubRepositoryId: "1345851083",
      status: "verified",
      verifiedAt: "2026-08-30T11:59:00.000Z",
    },
    project: {
      projectId: "project-1",
      githubRepositoryId: "1345851083",
      repositoryFullName: "telaegent/telaegent-tiktok-techjam",
      visibility: "private",
      defaultBranch: "main",
      status: "active",
    },
    membership: {
      projectId: "project-1",
      userId: "user-1",
      status: "active",
      joinedAt: "2026-08-30T10:00:00.000Z",
    },
    conversation: {
      conversationId: "conversation-1",
      projectId: "project-1",
      participantUserIds: ["user-1", "user-2"],
      status: "active",
    },
    projectConnections: [
      {
        projectConnectionId: "connection-1",
        projectId: "project-1",
        requesterUserId: "user-1",
        recipientUserId: "user-2",
        status: "connected",
        requestedAt: "2026-08-30T10:00:00.000Z",
        acceptedAt: "2026-08-30T10:01:00.000Z",
        revokedAt: null,
      },
    ],
    runtimeBinding: {
      runtimeBindingId: "runtime-binding-1",
      userId: "user-1",
      projectId: "project-1",
      githubRepositoryId: "1345851083",
      status: "ready",
    },
  };
}

function clientReturning(payload: unknown): SupabaseAuthorizationSnapshotClient & {
  fetchPrivateRuntimeAuthorizationSnapshot: ReturnType<typeof vi.fn>;
} {
  return {
    fetchPrivateRuntimeAuthorizationSnapshot: vi.fn(async () => payload),
  };
}

function authorizationService(
  client: SupabaseAuthorizationSnapshotClient,
): PrivateRuntimeAuthorizationService {
  return new PrivateRuntimeAuthorizationService(
    new SupabasePrivateRuntimeAuthorizationRepository(client),
    {
      repositoryAccessMaxAgeMs: 5 * 60_000,
      repositoryReadTimeoutMs: 100,
    },
    () => now,
  );
}

describe("Supabase authorization snapshot mapper", () => {
  it("maps a strict valid DTO into authorization-domain facts", () => {
    const payload = validPayload();
    const snapshot = mapSupabasePrivateRuntimeAuthorizationSnapshot(payload, 15);

    expect(snapshot).toEqual(payload);
    expect(snapshot).not.toBe(payload);
    expect(snapshot.runtimeBinding).toMatchObject({
      runtimeBindingId: "runtime-binding-1",
    });
  });

  it("retains null, inactive, and revoked facts for the authorization service", () => {
    const absent = mapSupabasePrivateRuntimeAuthorizationSnapshot({
      user: null,
      githubConnection: null,
      repositoryAccess: null,
      project: null,
      membership: null,
      conversation: null,
      projectConnections: [],
      runtimeBinding: null,
    });
    expect(absent.user).toBeNull();

    const revokedPayload = validPayload();
    revokedPayload.membership!.status = "revoked";
    revokedPayload.projectConnections = [{
      ...revokedPayload.projectConnections[0]!,
      status: "revoked",
      acceptedAt: "2026-08-30T10:01:00.000Z",
      revokedAt: "2026-08-30T11:30:00.000Z",
    }];
    const revoked = mapSupabasePrivateRuntimeAuthorizationSnapshot(revokedPayload);
    expect(revoked.membership?.status).toBe("revoked");
    expect(revoked.projectConnections[0]?.status).toBe("revoked");
  });

  it("rejects missing and unexpected fields instead of silently coercing rows", () => {
    const missing = structuredClone(validPayload()) as Partial<
      SupabasePrivateRuntimeAuthorizationSnapshotDto
    >;
    delete missing.user;
    expect(() => mapSupabasePrivateRuntimeAuthorizationSnapshot(missing)).toThrow(
      SupabaseAuthorizationRepositoryError,
    );

    const unexpected = {
      ...validPayload(),
      githubAccessToken: "secret-token",
    };
    const error = captureMapperError(unexpected);
    expect(error).toBeInstanceOf(SupabaseAuthorizationRepositoryError);
    expect(String(error)).not.toContain("secret-token");
    expect(JSON.stringify(error)).not.toContain("secret-token");
  });

  it("rejects malformed IDs, timestamps, and duplicate relationships", () => {
    const invalidRepository = validPayload();
    invalidRepository.project!.githubRepositoryId = "9223372036854775808";
    expect(() =>
      mapSupabasePrivateRuntimeAuthorizationSnapshot(invalidRepository),
    ).toThrow(SupabaseAuthorizationRepositoryError);

    const invalidTimestamp = validPayload();
    invalidTimestamp.repositoryAccess!.verifiedAt = "not-a-timestamp";
    expect(() =>
      mapSupabasePrivateRuntimeAuthorizationSnapshot(invalidTimestamp),
    ).toThrow(SupabaseAuthorizationRepositoryError);

    const duplicateParticipants = validPayload();
    duplicateParticipants.conversation!.participantUserIds = [
      "user-1",
      "user-2",
      "user-2",
    ];
    expect(() =>
      mapSupabasePrivateRuntimeAuthorizationSnapshot(duplicateParticipants),
    ).toThrow(SupabaseAuthorizationRepositoryError);

    const duplicateConnection = validPayload();
    duplicateConnection.projectConnections = [
      duplicateConnection.projectConnections[0]!,
      {
        ...duplicateConnection.projectConnections[0]!,
        projectConnectionId: "connection-2",
      },
    ];
    expect(() =>
      mapSupabasePrivateRuntimeAuthorizationSnapshot(duplicateConnection),
    ).toThrow(SupabaseAuthorizationRepositoryError);
  });

  it("enforces the caller's participant and relationship allocation bounds", () => {
    const excessiveParticipants = validPayload();
    excessiveParticipants.conversation!.participantUserIds = [
      "user-1",
      "user-2",
      "user-3",
      "user-4",
      "user-5",
    ];
    expect(() =>
      mapSupabasePrivateRuntimeAuthorizationSnapshot(excessiveParticipants, 2),
    ).toThrow(SupabaseAuthorizationRepositoryError);

    const excessiveConnections = validPayload();
    excessiveConnections.projectConnections = Array.from(
      { length: 4 },
      (_, index) => ({
        projectConnectionId: `connection-${index + 1}`,
        projectId: "project-1",
        requesterUserId: "user-1",
        recipientUserId: `peer-${index + 1}`,
        status: "connected" as const,
        requestedAt: "2026-08-30T10:00:00.000Z",
        acceptedAt: "2026-08-30T10:01:00.000Z",
        revokedAt: null,
      }),
    );
    expect(() =>
      mapSupabasePrivateRuntimeAuthorizationSnapshot(excessiveConnections, 2),
    ).toThrow(SupabaseAuthorizationRepositoryError);
  });

  it("rejects secret-like fields and workspace metadata on a non-ready binding", () => {
    const privatePath = "/srv/private/other-user";
    const leakedBinding = {
      ...validPayload(),
      runtimeBinding: {
        runtimeBindingId: "runtime-binding-1",
        userId: "user-1",
        projectId: "project-1",
        githubRepositoryId: "1345851083",
        status: "revoked",
        workspacePath: privatePath,
        credentialReference: "key-vault-secret",
      },
    };
    const error = captureMapperError(leakedBinding);

    expect(error).toBeInstanceOf(SupabaseAuthorizationRepositoryError);
    expect(String(error)).not.toContain(privatePath);
    expect(JSON.stringify(error)).not.toContain("key-vault-secret");
  });
});

describe("SupabasePrivateRuntimeAuthorizationRepository", () => {
  it("forwards one bounded RPC request and its cancellation signal", async () => {
    const client = clientReturning(validPayload());
    const repository = new SupabasePrivateRuntimeAuthorizationRepository(client);
    const controller = new AbortController();

    await expect(
      repository.loadPrivateRuntimeAuthorizationSnapshot(input, {
        signal: controller.signal,
        maximumProjectConnections: 15,
      }),
    ).resolves.toMatchObject({ user: { userId: "user-1" } });
    expect(client.fetchPrivateRuntimeAuthorizationSnapshot).toHaveBeenCalledWith(
      {
        authenticatedUserId: "user-1",
        githubRepositoryId: "1345851083",
        conversationId: "conversation-1",
        maximumProjectConnections: 15,
      },
      { signal: controller.signal },
    );
  });

  it("does not query when already cancelled and normalizes client failures", async () => {
    const client = clientReturning(validPayload());
    const repository = new SupabasePrivateRuntimeAuthorizationRepository(client);
    const controller = new AbortController();
    controller.abort();

    await expect(
      repository.loadPrivateRuntimeAuthorizationSnapshot(input, {
        signal: controller.signal,
        maximumProjectConnections: 15,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(client.fetchPrivateRuntimeAuthorizationSnapshot).not.toHaveBeenCalled();

    const failing = new SupabasePrivateRuntimeAuthorizationRepository({
      async fetchPrivateRuntimeAuthorizationSnapshot() {
        throw new Error("database leaked token and /srv/private/path");
      },
    });
    const error = await failing
      .loadPrivateRuntimeAuthorizationSnapshot(input, {
        maximumProjectConnections: 15,
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "SUPABASE_AUTHORIZATION_UNAVAILABLE",
      message: "Authorization persistence is temporarily unavailable",
    });
    expect(String(error)).not.toContain("/srv/private/path");
  });

  it("lets the authorization service deny revoked and inconsistent facts", async () => {
    const revoked = validPayload();
    revoked.membership!.status = "revoked";
    await expect(
      authorizationService(clientReturning(revoked)).authorizePrivateRuntime(input),
    ).rejects.toMatchObject({
      code: "PRIVATE_RUNTIME_FORBIDDEN",
      reason: "membership_unavailable",
    });

    const revokedConnection = validPayload();
    revokedConnection.projectConnections = [{
      ...revokedConnection.projectConnections[0]!,
      status: "revoked",
      acceptedAt: "2026-08-30T10:01:00.000Z",
      revokedAt: "2026-08-30T11:30:00.000Z",
    }];
    await expect(
      authorizationService(clientReturning(revokedConnection))
        .authorizePrivateRuntime(input),
    ).rejects.toMatchObject({
      code: "PRIVATE_RUNTIME_FORBIDDEN",
      reason: "project_connection_unavailable",
    });

    const inconsistent = validPayload();
    inconsistent.runtimeBinding!.userId = "user-2";
    await expect(
      authorizationService(clientReturning(inconsistent)).authorizePrivateRuntime(input),
    ).rejects.toMatchObject({
      code: "PRIVATE_RUNTIME_FORBIDDEN",
      reason: "inconsistent_scope",
    });
  });

  it("aborts a timed-out RPC and fails closed through the authorization service", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const client: SupabaseAuthorizationSnapshotClient = {
      fetchPrivateRuntimeAuthorizationSnapshot(_request, options) {
        receivedSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            const error = new Error("RPC aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    };
    const authorization = authorizationService(client).authorizePrivateRuntime(input);
    const rejection = expect(authorization).rejects.toMatchObject({
      code: "PRIVATE_RUNTIME_AUTHORIZATION_UNAVAILABLE",
      reason: "repository_read_failed",
      message: "Private runtime authorization is temporarily unavailable",
    });

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(receivedSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});

function captureMapperError(payload: unknown): unknown {
  try {
    mapSupabasePrivateRuntimeAuthorizationSnapshot(payload);
    return null;
  } catch (error) {
    return error;
  }
}
