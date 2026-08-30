import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { createConfiguredAuthorizationRepository } from "./authorization-repository-factory.js";
import { InMemoryPrivateRuntimeAuthorizationRepository } from "./in-memory-authorization-repository.js";
import { SupabasePrivateRuntimeAuthorizationRepository } from "./supabase-authorization-repository.js";

const secretKey = "sb_secret_" + "a".repeat(32);

describe("createConfiguredAuthorizationRepository", () => {
  it("defaults to an empty fail-closed memory repository", async () => {
    const repository = createConfiguredAuthorizationRepository(loadConfig({}));

    expect(repository).toBeInstanceOf(
      InMemoryPrivateRuntimeAuthorizationRepository,
    );
    await expect(
      repository.loadPrivateRuntimeAuthorizationSnapshot(
        {
          authenticatedUserId: "user-1",
          githubRepositoryId: "1",
          conversationId: "conversation-1",
        },
        { maximumProjectConnections: 15 },
      ),
    ).resolves.toEqual({
      user: null,
      githubConnection: null,
      repositoryAccess: null,
      project: null,
      membership: null,
      conversation: null,
      projectConnections: [],
      runtimeBinding: null,
    });
  });

  it("uses an injected local repository without cloning or silently replacing it", () => {
    const memoryRepository = new InMemoryPrivateRuntimeAuthorizationRepository({
      users: [],
      githubConnections: [],
      repositoryAccesses: [],
      projects: [],
      memberships: [],
      conversations: [],
      projectConnections: [],
      runtimeBindings: [],
    });

    expect(
      createConfiguredAuthorizationRepository(loadConfig({}), {
        memoryRepository,
      }),
    ).toBe(memoryRepository);
  });

  it("constructs Supabase persistence only after explicit opt-in", () => {
    const repository = createConfiguredAuthorizationRepository(
      loadConfig({
        AUTHORIZATION_PERSISTENCE: "supabase",
        SUPABASE_URL: "https://example-project.supabase.co",
        SUPABASE_SECRET_KEY: secretKey,
      }),
      { fetch: vi.fn<typeof fetch>() },
    );

    expect(repository).toBeInstanceOf(
      SupabasePrivateRuntimeAuthorizationRepository,
    );
  });
});
