import { describe, expect, it, vi } from "vitest";
import { UserAuthenticationError } from "../authentication/types.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { ProjectRepository } from "./repository.js";
import { ProjectService } from "./service.js";
import { SupabaseProjectRepository } from "./supabase-repository.js";
import type {
  ProjectConnection,
  ProjectConversation,
  ProjectDisconnect,
} from "./types.js";

const alice = "10000000-0000-4000-8000-00000000a001";
const bob = "10000000-0000-4000-8000-00000000b002";
const projectId = "20000000-0000-4000-8000-000000000001";
const connectionId = "30000000-0000-4000-8000-000000000001";
const conversationId = "40000000-0000-4000-8000-000000000001";
const now = new Date("2026-08-31T12:00:00.000Z");

/** Refuses every connection operation unless a test opts one in. */
function stubRepository(overrides: Partial<ProjectRepository> = {}): ProjectRepository {
  const refuse = async () => null;
  return {
    listForUser: async () => [],
    listCollaborators: refuse,
    requestConnection: refuse,
    respondToConnection: refuse,
    revokeConnection: refuse,
    disconnectRepository: refuse,
    createConversation: refuse,
    ...overrides,
  };
}

function service(overrides: Partial<ProjectRepository> = {}): ProjectService {
  return new ProjectService(stubRepository(overrides), {
    now: () => now,
    createId: () => connectionId,
  });
}

function connection(overrides: Partial<ProjectConnection> = {}): ProjectConnection {
  return {
    projectConnectionId: connectionId,
    projectId,
    requesterUserId: alice,
    recipientUserId: bob,
    status: "pending",
    requestedAt: now.toISOString(),
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function conversation(
  overrides: Partial<ProjectConversation> = {},
): ProjectConversation {
  return {
    conversationId,
    projectId,
    githubRepositoryId: "910",
    status: "active",
    participantUserIds: [alice, bob],
    created: true,
    ...overrides,
  };
}

function disconnect(overrides: Partial<ProjectDisconnect> = {}): ProjectDisconnect {
  return {
    projectId,
    githubRepositoryId: "910",
    repositoryAccessStatus: "revalidation_required",
    membershipStatus: "suspended",
    bindingStatus: "stopped",
    disconnectedAt: now.toISOString(),
    changed: true,
    ...overrides,
  };
}

async function appWith(
  repository: ProjectRepository,
  authenticatedUserId: () => Promise<string> = async () => alice,
  onRepositoryDisconnected?: (userId: string, repositoryId: string) => Promise<void>,
) {
  return createApp(
    loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "legacy-admin-token" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      service: new ProjectService(repository, {
        now: () => now,
        createId: () => connectionId,
      }),
      authenticatedUserId,
      ...(onRepositoryDisconnected ? { onRepositoryDisconnected } : {}),
    },
  );
}

describe("ProjectService connection lifecycle", () => {
  it("mints the connection identifier itself rather than taking it from the caller", async () => {
    const requestConnection = vi.fn<ProjectRepository["requestConnection"]>(
      async () => connection(),
    );
    const result = await service({ requestConnection }).requestConnection({
      authenticatedUserId: alice,
      projectId,
      recipientUserId: bob,
    });
    expect(requestConnection).toHaveBeenCalledWith({
      projectConnectionId: connectionId,
      projectId,
      requesterUserId: alice,
      recipientUserId: bob,
      requestedAt: now.toISOString(),
    });
    expect(result.connection.status).toBe("pending");
  });

  it("answers on behalf of the authenticated recipient, never a claimed one", async () => {
    const respondToConnection = vi.fn<ProjectRepository["respondToConnection"]>(
      async () => connection({ status: "connected", acceptedAt: now.toISOString() }),
    );
    await service({ respondToConnection }).respondToConnection({
      authenticatedUserId: bob,
      projectConnectionId: connectionId,
      decision: "accept",
    });
    expect(respondToConnection).toHaveBeenCalledWith({
      projectConnectionId: connectionId,
      recipientUserId: bob,
      decision: "accept",
      respondedAt: now.toISOString(),
    });
  });

  it("refuses to connect or converse with oneself", async () => {
    await expect(
      service().requestConnection({
        authenticatedUserId: alice,
        projectId,
        recipientUserId: alice,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      service().createConversation({
        authenticatedUserId: alice,
        projectId,
        peerUserId: alice,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("reports one uninformative refusal for every database refusal", async () => {
    const refused = service();
    const attempts = [
      refused.listCollaborators({ authenticatedUserId: alice, projectId, limit: 50 }),
      refused.requestConnection({
        authenticatedUserId: alice,
        projectId,
        recipientUserId: bob,
      }),
      refused.respondToConnection({
        authenticatedUserId: bob,
        projectConnectionId: connectionId,
        decision: "accept",
      }),
      refused.revokeConnection({
        authenticatedUserId: alice,
        projectConnectionId: connectionId,
      }),
      refused.disconnectRepository({ authenticatedUserId: alice, projectId }),
      refused.createConversation({
        authenticatedUserId: alice,
        projectId,
        peerUserId: bob,
      }),
    ];
    for (const attempt of attempts) {
      // A caller who may not act learns only that, never whether the project,
      // the peer, or the connection exists.
      await expect(attempt).rejects.toMatchObject({
        statusCode: 403,
        message: "This project connection action is not available",
      });
    }
  });
});

describe("project connection routes", () => {
  it("disconnects only the web-session owner's project and awaits relay removal", async () => {
    const disconnectRepository = vi.fn<ProjectRepository["disconnectRepository"]>(
      async () => disconnect(),
    );
    const onRepositoryDisconnected = vi.fn(async () => undefined);
    const app = await appWith(
      stubRepository({ disconnectRepository }),
      async () => alice,
      onRepositoryDisconnected,
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/disconnect`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.json()).toEqual({ disconnect: disconnect() });
    expect(disconnectRepository).toHaveBeenCalledWith({
      authenticatedUserId: alice,
      projectId,
    });
    expect(onRepositoryDisconnected).toHaveBeenCalledWith(alice, "910");
    await app.close();
  });

  it("keeps durable disconnect effective when relay cleanup fails", async () => {
    const disconnectRepository = vi.fn<ProjectRepository["disconnectRepository"]>(
      async () => disconnect({ changed: false }),
    );
    const app = await appWith(
      stubRepository({ disconnectRepository }),
      async () => alice,
      async () => { throw new Error("relay cleanup failed"); },
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/disconnect`,
      payload: {},
    });
    expect(response.statusCode).toBe(500);
    expect(disconnectRepository).toHaveBeenCalledOnce();
    await app.close();
  });

  it("opens a conversation for a connected pair and is idempotent afterwards", async () => {
    const createConversation = vi.fn<ProjectRepository["createConversation"]>(
      async () => conversation(),
    );
    const app = await appWith(stubRepository({ createConversation }));
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/conversations`,
      payload: { peerUserId: bob },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(created.json().conversation.conversationId).toBe(conversationId);
    expect(createConversation).toHaveBeenCalledWith({
      conversationId: connectionId,
      projectId,
      authenticatedUserId: alice,
      peerUserId: bob,
    });

    createConversation.mockResolvedValueOnce(conversation({ created: false }));
    const reopened = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/conversations`,
      payload: { peerUserId: bob },
    });
    // Already open, so the pair's canonical history is returned rather than a
    // second conversation being created.
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().conversation.conversationId).toBe(conversationId);
    await app.close();
  });

  it("carries per-user authorization without the shared deployment token", async () => {
    const app = await appWith(
      stubRepository({
        listCollaborators: async () => [
          {
            userId: bob,
            githubLogin: "bob-gh",
            connectionStatus: "pending_incoming",
            projectConnectionId: connectionId,
          },
        ],
      }),
    );
    // APP_AUTH_TOKEN is set on this app, yet no Authorization header is sent:
    // these routes are exempt because they authenticate the user themselves.
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collaborators`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().collaborators[0]?.connectionStatus).toBe("pending_incoming");
    expect(response.json().nextCursor).toBeNull();
    await app.close();
  });

  it("rejects unauthenticated callers on every connection route", async () => {
    const app = await appWith(stubRepository(), async () => {
      throw new UserAuthenticationError(
        "AUTHENTICATION_REQUIRED",
        "Authentication required",
      );
    });
    const routes: Array<[string, string, unknown]> = [
      ["GET", `/api/projects/${projectId}/collaborators`, undefined],
      ["POST", `/api/projects/${projectId}/connections`, { recipientUserId: bob }],
      [
        "POST",
        `/api/projects/${projectId}/connections/${connectionId}/respond`,
        { decision: "accept" },
      ],
      ["POST", `/api/projects/${projectId}/connections/${connectionId}/revoke`, {}],
      ["POST", `/api/projects/${projectId}/disconnect`, {}],
      ["POST", `/api/projects/${projectId}/conversations`, { peerUserId: bob }],
    ];
    for (const [method, url, payload] of routes) {
      const response = await app.inject({
        method: method as "GET" | "POST",
        url,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(401);
    }
    await app.close();
  });

  it("rejects malformed identifiers, decisions, and unknown body fields", async () => {
    const app = await appWith(stubRepository());
    const rejected: Array<[string, string, unknown]> = [
      ["GET", "/api/projects/not-a-uuid/collaborators", undefined],
      ["GET", `/api/projects/${projectId}/collaborators?cursor=not-base64`, undefined],
      ["POST", `/api/projects/${projectId}/connections`, { recipientUserId: "nope" }],
      [
        "POST",
        `/api/projects/${projectId}/connections`,
        { recipientUserId: bob, projectConnectionId: connectionId },
      ],
      [
        "POST",
        `/api/projects/${projectId}/connections/${connectionId}/respond`,
        { decision: "maybe" },
      ],
      ["POST", `/api/projects/${projectId}/conversations`, { peerUserId: "nope" }],
      ["POST", `/api/projects/${projectId}/disconnect`, { unexpected: true }],
    ];
    for (const [method, url, payload] of rejected) {
      const response = await app.inject({
        method: method as "GET" | "POST",
        url,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });
});

describe("SupabaseProjectRepository connection calls", () => {
  function repository(fetchImplementation: typeof fetch): SupabaseProjectRepository {
    return new SupabaseProjectRepository(
      "https://example.supabase.co",
      `sb_secret_${"c".repeat(32)}`,
      1_000,
      fetchImplementation,
    );
  }

  it("passes a database refusal through as null rather than as an error", async () => {
    const fetchImplementation = vi.fn(async () => new Response("null", { status: 200 }));
    const subject = repository(fetchImplementation as unknown as typeof fetch);
    await expect(
      subject.listCollaborators({
        authenticatedUserId: alice,
        projectId,
        afterUserId: null,
        limit: 50,
      }),
    ).resolves.toBeNull();
    await expect(
      subject.createConversation({
        conversationId,
        projectId,
        authenticatedUserId: alice,
        peerUserId: bob,
      }),
    ).resolves.toBeNull();
    const [url, request] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(
      "https://example.supabase.co/rest/v1/rpc/list_project_collaborators_page",
    );
    expect(JSON.parse(String((request as RequestInit | undefined)?.body))).toEqual({
      p_user_id: alice,
      p_project_id: projectId,
      p_after_user_id: null,
      p_limit: 50,
    });
  });

  it("never mistakes a malformed payload for a successful authorization", async () => {
    const fetchImplementation = vi.fn(async () => new Response(
      JSON.stringify({ projectConnectionId: connectionId, status: "connected" }),
      { status: 200 },
    ));
    await expect(
      repository(fetchImplementation as unknown as typeof fetch).requestConnection({
        projectConnectionId: connectionId,
        projectId,
        requesterUserId: alice,
        recipientUserId: bob,
        requestedAt: now.toISOString(),
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("calls the disconnect RPC with only session-derived user and project scope", async () => {
    const fetchImplementation = vi.fn(async () => new Response(
      JSON.stringify(disconnect()),
      { status: 200 },
    ));
    await expect(repository(fetchImplementation as unknown as typeof fetch)
      .disconnectRepository({ authenticatedUserId: alice, projectId }))
      .resolves.toEqual(disconnect());
    const [url, request] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(
      "https://example.supabase.co/rest/v1/rpc/disconnect_user_repository",
    );
    expect(JSON.parse(String((request as RequestInit | undefined)?.body))).toEqual({
      p_user_id: alice,
      p_project_id: projectId,
    });
  });
});
