import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { AgentClarificationCoordinator } from "../agent-clarification/coordinator.js";
import {
  AuthorizedConversationAccess,
  ConnectorUnavailableDraftRuntime,
  createConversationApi,
} from "./conversation-api-factory.js";

const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const DRAFT = "44444444-4444-4444-8444-444444444444";
const USER = "11111111-1111-4111-8111-111111111111";
const REPOSITORY = "1345851083";

// Every route the browser client calls, with a payload valid enough to reach
// the handler. A 404 here means the composition root stopped mounting the API.
const routes = [
  {
    method: "POST" as const,
    url: `/api/conversations/${CONVERSATION}/drafts`,
    payload: {
      githubRepositoryId: REPOSITORY,
      provider: "codex",
      roughMessage: "Ask whether the webhook payload changed.",
    },
  },
  { method: "GET" as const, url: `/api/drafts/${DRAFT}` },
  {
    method: "GET" as const,
    url: `/api/conversations/${CONVERSATION}/drafts?githubRepositoryId=${REPOSITORY}`,
  },
  { method: "POST" as const, url: `/api/drafts/${DRAFT}/run` },
  {
    method: "POST" as const,
    url: `/api/drafts/${DRAFT}/messages`,
    payload: { content: "Narrow it to the retry path." },
  },
  { method: "POST" as const, url: `/api/drafts/${DRAFT}/cancel` },
  {
    method: "POST" as const,
    url: `/api/drafts/${DRAFT}/send`,
    payload: { idempotencyKey: "send-1" },
  },
  {
    method: "GET" as const,
    url: `/api/conversations/${CONVERSATION}/messages?githubRepositoryId=${REPOSITORY}`,
  },
];

function app(authenticatedUserId?: () => string) {
  const config = loadConfig({ NODE_ENV: "test" });
  return createApp(
    config,
    undefined,
    undefined,
    createConversationApi(config, {
      ...(authenticatedUserId ? { authenticatedUserId } : {}),
    }),
  );
}

describe("createConversationApi", () => {
  it("mounts every conversation route the browser client calls", async () => {
    const instance = await app();
    try {
      for (const route of routes) {
        const response = await instance.inject(route);
        expect({ url: route.url, status: response.statusCode }).toEqual({
          url: route.url,
          // Refused for want of an identity, not missing. A 404 would mean the
          // API is built but never composed into the running server.
          status: 401,
        });
      }
    } finally {
      await instance.close();
    }
  });

  it("runs real product authorization once an identity is present", async () => {
    const instance = await app(() => USER);
    try {
      const response = await instance.inject(routes[0]!);
      // The default authorization repository holds no user, membership, or
      // project connection, so a real fail-closed decision denies the draft.
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: "Private runtime is not authorized",
        code: "PRIVATE_RUNTIME_FORBIDDEN",
        retryable: false,
      });
    } finally {
      await instance.close();
    }
  });
});

describe("agent clarification composition", () => {
  // `index.ts` decides the flag; this factory is where the decision becomes a
  // wired coordinator and a value the browser can read. Both halves are
  // asserted because "off" has to mean the coordinator is genuinely absent, not
  // merely unadvertised -- an absent coordinator is what makes every service
  // method return null instead of reaching an unmigrated database.
  const config = () => loadConfig({ NODE_ENV: "test" });

  it("wires no coordinator, and advertises none, when nothing is passed", () => {
    const api = createConversationApi(config(), {});

    expect(api.agentClarificationEnabled).toBe(false);
  });

  it("advertises the loop only when a coordinator is really wired", () => {
    const api = createConversationApi(config(), {
      agentClarification: {} as AgentClarificationCoordinator,
    });

    expect(api.agentClarificationEnabled).toBe(true);
  });

  it("reports the loop as off to the browser client", async () => {
    const instance = await app(() => USER);
    try {
      const response = await instance.inject({
        method: "GET",
        url: `/api/runtime/models?githubRepositoryId=${REPOSITORY}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().agentClarificationEnabled).toBe(false);
    } finally {
      await instance.close();
    }
  });
});

describe("ConnectorUnavailableDraftRuntime", () => {
  it("refuses a turn instead of running a provider in the cloud", async () => {
    const runtime = new ConnectorUnavailableDraftRuntime();
    await expect(runtime.start()).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
    await expect(runtime.cancel()).resolves.toBe(false);
  });
});

describe("AuthorizedConversationAccess", () => {
  it("does not require a live runtime for read, send, or cancel", async () => {
    const authorizePrivateRuntime = vi.fn(async () => ({
      userId: USER,
      githubRepositoryId: REPOSITORY,
      runtimeBindingId: "binding",
    }));
    const authorizeConversationAccess = vi.fn(async () => undefined);
    const access = new AuthorizedConversationAccess({
      authorizePrivateRuntime,
      authorizeConversationAccess,
    });
    const scope = {
      authenticatedUserId: USER,
      githubRepositoryId: REPOSITORY,
      conversationId: CONVERSATION,
    };

    for (const action of ["read", "send", "cancel"] as const) {
      await access.authorize({ ...scope, action });
    }
    await access.authorize({ ...scope, action: "run_draft" });

    expect(authorizeConversationAccess).toHaveBeenCalledTimes(3);
    expect(authorizePrivateRuntime).toHaveBeenCalledTimes(1);
  });
});
