import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import {
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

describe("ConnectorUnavailableDraftRuntime", () => {
  it("refuses a turn instead of running a provider in the cloud", async () => {
    const runtime = new ConnectorUnavailableDraftRuntime();
    await expect(runtime.start()).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
    await expect(runtime.cancel()).resolves.toBe(false);
  });
});
