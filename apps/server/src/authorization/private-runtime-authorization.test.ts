import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PrivateRuntimeAuthorizationError,
  PrivateRuntimeAuthorizationService,
  RealpathWorkspaceBoundary,
  type AuthorizePrivateRuntimeInput,
  type PrivateRuntimeAuthorizationReadOptions,
  type PrivateRuntimeAuthorizationRepository,
  type PrivateRuntimeAuthorizationSnapshot,
  type WorkspaceBoundary,
} from "./index.js";

const now = new Date("2026-08-30T12:00:00.000Z");
const input: AuthorizePrivateRuntimeInput = {
  authenticatedUserId: "user-1",
  githubRepositoryId: "1345851083",
  conversationId: "conversation-1",
};

function validSnapshot(): PrivateRuntimeAuthorizationSnapshot {
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
        projectConnectionId: "project-connection-1",
        projectId: "project-1",
        requesterUserId: "user-2",
        recipientUserId: "user-1",
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
      workspacePath: "/srv/telaegent/user-1/1345851083",
    },
  };
}

class SnapshotRepository implements PrivateRuntimeAuthorizationRepository {
  calls = 0;
  lastSignal: AbortSignal | undefined;
  lastMaximumProjectConnections: number | undefined;

  constructor(
    public snapshot: PrivateRuntimeAuthorizationSnapshot = validSnapshot(),
  ) {}

  async loadPrivateRuntimeAuthorizationSnapshot(
    _input: Readonly<AuthorizePrivateRuntimeInput>,
    options?: Readonly<PrivateRuntimeAuthorizationReadOptions>,
  ): Promise<PrivateRuntimeAuthorizationSnapshot> {
    this.calls += 1;
    this.lastSignal = options?.signal;
    this.lastMaximumProjectConnections = options?.maximumProjectConnections;
    return this.snapshot;
  }
}

const allowWorkspace: WorkspaceBoundary = {
  async contains() {
    return true;
  },
};

function service(
  repository: PrivateRuntimeAuthorizationRepository,
  workspaceBoundary: WorkspaceBoundary = allowWorkspace,
): PrivateRuntimeAuthorizationService {
  return new PrivateRuntimeAuthorizationService(
    repository,
    workspaceBoundary,
    {
      repositoryAccessMaxAgeMs: 5 * 60_000,
      repositoryReadTimeoutMs: 100,
    },
    () => now,
  );
}

function expectForbidden(
  action: Promise<unknown>,
  reason: PrivateRuntimeAuthorizationError["reason"],
): Promise<void> {
  return expect(action).rejects.toMatchObject({
    name: "PrivateRuntimeAuthorizationError",
    code: "PRIVATE_RUNTIME_FORBIDDEN",
    reason,
    message: "Private runtime is not authorized",
  });
}

describe("PrivateRuntimeAuthorizationService", () => {
  it("returns only the owner-scoped runtime contract", async () => {
    const repository = new SnapshotRepository();

    await expect(service(repository).authorizePrivateRuntime(input)).resolves.toEqual({
      userId: "user-1",
      githubRepositoryId: "1345851083",
      workspacePath: "/srv/telaegent/user-1/1345851083",
      runtimeBindingId: "runtime-binding-1",
    });
    expect(repository.calls).toBe(1);
    expect(repository.lastSignal).toBeInstanceOf(AbortSignal);
    expect(repository.lastMaximumProjectConnections).toBe(15);
  });

  it("rejects malformed scope before querying persistence", async () => {
    const repository = new SnapshotRepository();
    await expectForbidden(
      service(repository).authorizePrivateRuntime({
        ...input,
        githubRepositoryId: "1345851083 OR 1=1",
      }),
      "invalid_request",
    );
    expect(repository.calls).toBe(0);
  });

  it.each([
    ["disabled user", (s: PrivateRuntimeAuthorizationSnapshot) => {
      s.user = { userId: "user-1", status: "disabled" };
    }, "inactive_user"],
    ["disconnected GitHub", (s: PrivateRuntimeAuthorizationSnapshot) => {
      if (s.githubConnection) s.githubConnection.status = "reconnect_required";
    }, "github_connection_unavailable"],
    ["wrong repository", (s: PrivateRuntimeAuthorizationSnapshot) => {
      if (s.repositoryAccess) s.repositoryAccess.githubRepositoryId = "999";
    }, "inconsistent_scope"],
    ["suspended membership", (s: PrivateRuntimeAuthorizationSnapshot) => {
      if (s.membership) s.membership.status = "suspended";
    }, "membership_unavailable"],
    ["closed conversation", (s: PrivateRuntimeAuthorizationSnapshot) => {
      if (s.conversation) s.conversation.status = "closed";
    }, "conversation_unavailable"],
    ["revoked collaborator", (s: PrivateRuntimeAuthorizationSnapshot) => {
      s.projectConnections = [{
        ...s.projectConnections[0]!,
        status: "revoked",
        revokedAt: "2026-08-30T11:00:00.000Z",
      }];
    }, "project_connection_unavailable"],
    ["other user's binding", (s: PrivateRuntimeAuthorizationSnapshot) => {
      if (s.runtimeBinding) s.runtimeBinding.userId = "user-2";
    }, "inconsistent_scope"],
  ] as const)("denies a %s", async (_label, mutate, reason) => {
    const snapshot = validSnapshot();
    mutate(snapshot);
    await expectForbidden(
      service(new SnapshotRepository(snapshot)).authorizePrivateRuntime(input),
      reason,
    );
  });

  it("requires a recent repository-access proof", async () => {
    const snapshot = validSnapshot();
    snapshot.repositoryAccess!.verifiedAt = "2026-08-30T11:54:59.999Z";

    await expectForbidden(
      service(new SnapshotRepository(snapshot)).authorizePrivateRuntime(input),
      "repository_access_stale",
    );
  });

  it("rejects duplicate or excessive conversation participants", async () => {
    const duplicate = validSnapshot();
    duplicate.conversation!.participantUserIds = ["user-1", "user-2", "user-2"];
    await expectForbidden(
      service(new SnapshotRepository(duplicate)).authorizePrivateRuntime(input),
      "inconsistent_scope",
    );

    const excessive = validSnapshot();
    excessive.conversation!.participantUserIds = Array.from(
      { length: 17 },
      (_, index) => `user-${index + 1}`,
    );
    await expectForbidden(
      service(new SnapshotRepository(excessive)).authorizePrivateRuntime(input),
      "conversation_unavailable",
    );
  });

  it("does not cache a previous allow across revocation", async () => {
    const repository = new SnapshotRepository();
    const authorizer = service(repository);
    await expect(authorizer.authorizePrivateRuntime(input)).resolves.toBeDefined();

    repository.snapshot = validSnapshot();
    repository.snapshot.membership!.status = "revoked";
    await expectForbidden(
      authorizer.authorizePrivateRuntime(input),
      "membership_unavailable",
    );
    expect(repository.calls).toBe(2);
  });

  it("aborts and safely normalizes a slow repository read", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const repository: PrivateRuntimeAuthorizationRepository = {
      loadPrivateRuntimeAuthorizationSnapshot(_request, options) {
        signal = options?.signal;
        return new Promise(() => undefined);
      },
    };
    const authorization = service(repository).authorizePrivateRuntime(input);
    const rejection = expect(authorization).rejects.toMatchObject({
      code: "PRIVATE_RUNTIME_AUTHORIZATION_UNAVAILABLE",
      reason: "repository_read_failed",
      message: "Private runtime authorization is temporarily unavailable",
    });
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("does not expose repository or workspace details in errors", async () => {
    const repository: PrivateRuntimeAuthorizationRepository = {
      async loadPrivateRuntimeAuthorizationSnapshot() {
        throw new Error("database leaked /srv/private and token ghp_example");
      },
    };

    const error = await service(repository)
      .authorizePrivateRuntime(input)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrivateRuntimeAuthorizationError);
    expect(String(error)).not.toContain("/srv/private");
    expect(String(error)).not.toContain("ghp_example");
    expect(String(error)).not.toContain(input.githubRepositoryId);
    expect(JSON.stringify(error)).not.toContain("repository_read_failed");
  });

  it("denies a workspace rejected by the server boundary", async () => {
    await expectForbidden(
      service(new SnapshotRepository(), {
        async contains() {
          return false;
        },
      }).authorizePrivateRuntime(input),
      "workspace_outside_boundary",
    );
  });

  it("normalizes an unexpected workspace-boundary failure", async () => {
    await expect(
      service(new SnapshotRepository(), {
        async contains() {
          throw new Error("private path /srv/telaegent/user-1");
        },
      }).authorizePrivateRuntime(input),
    ).rejects.toMatchObject({
      code: "PRIVATE_RUNTIME_AUTHORIZATION_UNAVAILABLE",
      reason: "workspace_boundary_failed",
      message: "Private runtime authorization is temporarily unavailable",
    });
  });
});

describe("RealpathWorkspaceBoundary", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  });

  it("accepts a real child and rejects root, sibling, and symlink escapes", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "telaegent-auth-"));
    temporaryRoots.push(temporaryRoot);
    const workspaceRoot = path.join(temporaryRoot, "workspaces");
    const workspace = path.join(workspaceRoot, "user-1", "repo-1");
    const outside = path.join(temporaryRoot, "outside");
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    const escape = path.join(workspaceRoot, "escape");
    await symlink(
      outside,
      escape,
      process.platform === "win32" ? "junction" : "dir",
    );
    const boundary = new RealpathWorkspaceBoundary(workspaceRoot);

    await expect(boundary.contains({ workspacePath: workspace })).resolves.toBe(true);
    await expect(boundary.contains({ workspacePath: workspaceRoot })).resolves.toBe(false);
    await expect(boundary.contains({ workspacePath: outside })).resolves.toBe(false);
    await expect(boundary.contains({ workspacePath: escape })).resolves.toBe(false);
  });
});
