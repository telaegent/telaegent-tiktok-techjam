import { describe, expect, it } from "vitest";
import {
  InMemoryPrivateRuntimeAuthorizationRepository,
  type AuthorizePrivateRuntimeInput,
  type InMemoryPrivateRuntimeAuthorizationData,
} from "./index.js";

const input: AuthorizePrivateRuntimeInput = {
  authenticatedUserId: "user-1",
  githubRepositoryId: "1345851083",
  conversationId: "conversation-1",
};

function validData(): InMemoryPrivateRuntimeAuthorizationData {
  return {
    users: [{ userId: "user-1", status: "active" }],
    githubConnections: [{
      githubConnectionId: "github-connection-1",
      userId: "user-1",
      githubUserId: "12345",
      githubLogin: "khoa",
      status: "connected",
      connectedAt: "2026-08-30T10:00:00.000Z",
      lastVerifiedAt: "2026-08-30T11:59:00.000Z",
    }],
    repositoryAccesses: [{
      userId: "user-1",
      githubConnectionId: "github-connection-1",
      githubRepositoryId: "1345851083",
      status: "verified",
      verifiedAt: "2026-08-30T11:59:00.000Z",
    }],
    projects: [{
      projectId: "project-1",
      githubRepositoryId: "1345851083",
      repositoryFullName: "telaegent/telaegent-tiktok-techjam",
      visibility: "private",
      defaultBranch: "main",
      status: "active",
    }],
    memberships: [{
      projectId: "project-1",
      userId: "user-1",
      status: "active",
      joinedAt: "2026-08-30T10:00:00.000Z",
    }],
    conversations: [{
      conversationId: "conversation-1",
      projectId: "project-1",
      participantUserIds: ["user-1", "user-2"],
      status: "active",
    }],
    projectConnections: [{
      projectConnectionId: "connection-1",
      projectId: "project-1",
      requesterUserId: "user-2",
      recipientUserId: "user-1",
      status: "connected",
      requestedAt: "2026-08-30T10:00:00.000Z",
      acceptedAt: "2026-08-30T10:01:00.000Z",
      revokedAt: null,
    }],
    runtimeBindings: [{
      runtimeBindingId: "runtime-binding-1",
      userId: "user-1",
      projectId: "project-1",
      githubRepositoryId: "1345851083",
      status: "ready",
      workspacePath: "/srv/telaegent/user-1/1345851083",
    }],
  };
}

async function load(
  repository: InMemoryPrivateRuntimeAuthorizationRepository,
  maximumProjectConnections = 15,
) {
  return repository.loadPrivateRuntimeAuthorizationSnapshot(input, {
    maximumProjectConnections,
  });
}

describe("InMemoryPrivateRuntimeAuthorizationRepository", () => {
  it("loads indexed authorization facts without making permission decisions", async () => {
    const data = validData();
    data.memberships[0]!.status = "revoked";
    data.projectConnections[0] = {
      ...data.projectConnections[0]!,
      status: "revoked",
      acceptedAt: "2026-08-30T10:01:00.000Z",
      revokedAt: "2026-08-30T11:00:00.000Z",
    };
    const snapshot = await load(
      new InMemoryPrivateRuntimeAuthorizationRepository(data),
    );

    expect(snapshot.membership?.status).toBe("revoked");
    expect(snapshot.projectConnections[0]?.status).toBe("revoked");
    expect(snapshot.runtimeBinding).toMatchObject({
      runtimeBindingId: "runtime-binding-1",
      workspacePath: "/srv/telaegent/user-1/1345851083",
    });
  });

  it("owns input and output values so external mutation cannot change policy", async () => {
    const data = validData();
    const repository = new InMemoryPrivateRuntimeAuthorizationRepository(data);
    data.users[0]!.status = "disabled";

    const first = await load(repository);
    first.user!.status = "deleted";
    first.conversation!.participantUserIds = ["attacker"];

    const second = await load(repository);
    expect(second.user?.status).toBe("active");
    expect(second.conversation?.participantUserIds).toEqual(["user-1", "user-2"]);
  });

  it("replaces all indexes atomically and preserves old data on invalid replacement", async () => {
    const repository = new InMemoryPrivateRuntimeAuthorizationRepository(validData());
    const revoked = validData();
    revoked.memberships[0]!.status = "revoked";
    repository.replaceData(revoked);
    expect((await load(repository)).membership?.status).toBe("revoked");

    const invalid = validData();
    invalid.users = [...invalid.users, { userId: "user-1", status: "disabled" }];
    expect(() => repository.replaceData(invalid)).toThrow(
      "Invalid in-memory authorization data.",
    );
    expect((await load(repository)).membership?.status).toBe("revoked");
  });

  it("rejects duplicate primary identities even when their lookup scopes differ", () => {
    const data = validData();
    data.runtimeBindings = [
      ...data.runtimeBindings,
      {
        runtimeBindingId: "runtime-binding-1",
        userId: "user-2",
        projectId: "project-1",
        githubRepositoryId: "1345851083",
        status: "ready",
        workspacePath: "/srv/telaegent/user-2/1345851083",
      },
    ];

    expect(
      () => new InMemoryPrivateRuntimeAuthorizationRepository(data),
    ).toThrow("Invalid in-memory authorization data.");
  });

  it("bounds hostile participant and relationship cardinality", async () => {
    const data = validData();
    const peers = Array.from({ length: 20 }, (_, index) => `peer-${index + 1}`);
    data.conversations[0]!.participantUserIds = ["user-1", ...peers];
    data.projectConnections = peers.map((peer, index) => ({
      projectConnectionId: `connection-${index + 1}`,
      projectId: "project-1",
      requesterUserId: "user-1",
      recipientUserId: peer,
      status: "connected" as const,
      requestedAt: "2026-08-30T10:00:00.000Z",
      acceptedAt: "2026-08-30T10:01:00.000Z",
      revokedAt: null,
    }));

    const snapshot = await load(
      new InMemoryPrivateRuntimeAuthorizationRepository(data),
      2,
    );
    expect(snapshot.conversation?.participantUserIds).toHaveLength(4);
    expect(snapshot.projectConnections).toHaveLength(3);
  });

  it("returns null facts for unknown scope and honors an already-aborted read", async () => {
    const repository = new InMemoryPrivateRuntimeAuthorizationRepository(validData());
    const missing = await repository.loadPrivateRuntimeAuthorizationSnapshot(
      { ...input, authenticatedUserId: "unknown" },
      { maximumProjectConnections: 15 },
    );
    expect(missing.user).toBeNull();
    expect(missing.projectConnections).toEqual([]);

    const controller = new AbortController();
    controller.abort();
    await expect(
      repository.loadPrivateRuntimeAuthorizationSnapshot(input, {
        signal: controller.signal,
        maximumProjectConnections: 15,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
