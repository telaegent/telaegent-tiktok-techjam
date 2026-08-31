import { describe, expect, it, vi } from "vitest";
import { UserAuthenticationError } from "../authentication/types.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { ProjectRepository } from "./repository.js";
import { ProjectService } from "./service.js";

const userId = "10000000-0000-4000-8000-000000000001";

/** Refuses every connection operation unless a test opts one in. */
function stubRepository(overrides: Partial<ProjectRepository> = {}): ProjectRepository {
  const refuse = async () => null;
  return {
    listForUser: async () => [],
    listCollaborators: refuse,
    requestConnection: refuse,
    respondToConnection: refuse,
    revokeConnection: refuse,
    createConversation: refuse,
    ...overrides,
  };
}

describe("project discovery routes", () => {
  it("uses the web-session owner and returns a non-cacheable bounded page", async () => {
    const listForUser = vi.fn<ProjectRepository["listForUser"]>(async () => []);
    const authenticatedUserId = vi.fn(async () => userId);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "legacy-admin-token" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        service: new ProjectService(stubRepository({ listForUser })),
        authenticatedUserId,
      },
    );
    const response = await app.inject({ method: "GET", url: "/api/projects?limit=7" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.json()).toEqual({ projects: [], nextCursor: null });
    expect(authenticatedUserId).toHaveBeenCalledOnce();
    expect(listForUser).toHaveBeenCalledWith({
      authenticatedUserId: userId,
      afterGitHubRepositoryId: null,
      limit: 8,
    });
    await app.close();
  });

  it("requires the Telaegent browser session and rejects unknown query fields", async () => {
    const repository = stubRepository();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        service: new ProjectService(repository),
        authenticatedUserId: async () => {
          throw new UserAuthenticationError(
            "AUTHENTICATION_REQUIRED",
            "Authentication required",
          );
        },
      },
    );
    const unauthenticated = await app.inject({ method: "GET", url: "/api/projects" });
    expect(unauthenticated.statusCode).toBe(401);

    const unauthenticatedInvalid = await app.inject({
      method: "GET",
      url: "/api/projects?unexpected=true",
    });
    expect(unauthenticatedInvalid.statusCode).toBe(401);
    await app.close();

    const authenticatedApp = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        service: new ProjectService(repository),
        authenticatedUserId: async () => userId,
      },
    );
    const invalid = await authenticatedApp.inject({
      method: "GET",
      url: "/api/projects?unexpected=true",
    });
    expect(invalid.statusCode).toBe(400);
    await authenticatedApp.close();
  });
});
