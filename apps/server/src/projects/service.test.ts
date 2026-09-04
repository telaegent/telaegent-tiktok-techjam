import { describe, expect, it } from "vitest";
import type { ProjectRepository } from "./repository.js";
import { ProjectService } from "./service.js";
import type { ProjectCollaborator, ProjectSummary } from "./types.js";

const userId = "10000000-0000-4000-8000-000000000001";

function project(githubRepositoryId: string): ProjectSummary {
  return {
    projectId: `20000000-0000-4000-8000-${githubRepositoryId.padStart(12, "0")}`,
    githubRepositoryId,
    repositoryFullName: `telaegent/project-${githubRepositoryId}`,
    visibility: "private",
    defaultBranch: "main",
    projectStatus: "active",
    membershipStatus: "active",
    membershipJoinedAt: "2026-08-31T00:00:00.000Z",
    githubConnectionStatus: "connected",
    repositoryAccessStatus: "verified",
    repositoryVerifiedAt: "2026-08-31T00:00:00.000Z",
    connectedCollaboratorCount: 1,
    binding: {
      connectorBindingId: `30000000-0000-4000-8000-${githubRepositoryId.padStart(12, "0")}`,
      connectorInstanceId: "connector_instance_0001",
      status: "ready",
      currentBranch: "main",
      commitSha: "a".repeat(40),
      repositoryPermission: "write",
      lastVerifiedAt: "2026-08-31T00:00:00.000Z",
      lastSeenAt: "2026-08-31T00:00:00.000Z",
      unavailableReason: null,
    },
  };
}

function collaborator(suffix: string): ProjectCollaborator {
  return {
    userId: `40000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    githubLogin: `collaborator-${suffix}`,
    connectionStatus: "none",
    projectConnectionId: null,
  };
}

/** Every connection operation refuses; these tests only exercise discovery. */
const refusesConnections = {
  listCollaborators: async () => null,
  requestConnection: async () => null,
  respondToConnection: async () => null,
  revokeConnection: async () => null,
  disconnectRepository: async () => null,
  createConversation: async () => null,
} as const;

class MemoryProjects implements ProjectRepository {
  readonly rows = [project("10"), project("20"), project("30")];
  readonly calls: Array<Parameters<ProjectRepository["listForUser"]>[0]> = [];

  listCollaborators = refusesConnections.listCollaborators;
  requestConnection = refusesConnections.requestConnection;
  respondToConnection = refusesConnections.respondToConnection;
  revokeConnection = refusesConnections.revokeConnection;
  disconnectRepository = refusesConnections.disconnectRepository;
  createConversation = refusesConnections.createConversation;

  async listForUser(
    input: Parameters<ProjectRepository["listForUser"]>[0],
  ): Promise<ProjectSummary[]> {
    this.calls.push(input);
    return this.rows
      .filter(
        (row) =>
          input.afterGitHubRepositoryId === null ||
          BigInt(row.githubRepositoryId) > BigInt(input.afterGitHubRepositoryId),
      )
      .slice(0, input.limit);
  }
}

describe("ProjectService", () => {
  it("uses stable keyset cursors without skipping or repeating projects", async () => {
    const repository = new MemoryProjects();
    const service = new ProjectService(repository);
    const first = await service.listProjects({ authenticatedUserId: userId, limit: 2 });
    expect(first.projects.map((row) => row.githubRepositoryId)).toEqual(["10", "20"]);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(repository.calls[0]).toEqual({
      authenticatedUserId: userId,
      afterGitHubRepositoryId: null,
      limit: 3,
    });

    const second = await service.listProjects({
      authenticatedUserId: userId,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.projects.map((row) => row.githubRepositoryId)).toEqual(["30"]);
    expect(second.nextCursor).toBeNull();
    expect(repository.calls[1]?.afterGitHubRepositoryId).toBe("20");
  });

  it("rejects malformed, non-canonical, and oversized cursors", async () => {
    const service = new ProjectService(new MemoryProjects());
    for (const cursor of ["not-json", "abc=", "a".repeat(257)]) {
      await expect(
        service.listProjects({ authenticatedUserId: userId, limit: 20, cursor }),
      ).rejects.toMatchObject({ name: "ZodError" });
    }
  });

  it("paginates collaborators with a stable user cursor", async () => {
    const rows = [collaborator("10"), collaborator("20"), collaborator("30")];
    const calls: Array<
      Parameters<ProjectRepository["listCollaborators"]>[0]
    > = [];
    const repository: ProjectRepository = {
      ...refusesConnections,
      listForUser: async () => [],
      listCollaborators: async (input) => {
        calls.push(input);
        return rows
          .filter(
            (row) =>
              input.afterUserId === null || row.userId > input.afterUserId,
          )
          .slice(0, input.limit);
      },
    };
    const service = new ProjectService(repository);

    const first = await service.listCollaborators({
      authenticatedUserId: userId,
      projectId: project("10").projectId,
      limit: 2,
    });
    expect(first.collaborators.map((row) => row.userId)).toEqual(
      rows.slice(0, 2).map((row) => row.userId),
    );
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(calls[0]).toMatchObject({ afterUserId: null, limit: 3 });

    const second = await service.listCollaborators({
      authenticatedUserId: userId,
      projectId: project("10").projectId,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.collaborators).toEqual([rows[2]]);
    expect(second.nextCursor).toBeNull();
    expect(calls[1]?.afterUserId).toBe(rows[1]?.userId);
  });

  it("fails closed if a repository violates the requested bound", async () => {
    const repository: ProjectRepository = {
      ...refusesConnections,
      listForUser: async () => [project("1"), project("2"), project("3")],
    };
    await expect(
      new ProjectService(repository).listProjects({ authenticatedUserId: userId, limit: 1 }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
