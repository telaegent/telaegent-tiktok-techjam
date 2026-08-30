import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import type { AgentService } from "../agent-service.js";
import { createApp } from "../app.js";
import { PrivateRuntimeAuthorizationError } from "../authorization/private-runtime-authorization.js";
import { loadConfig } from "../config.js";
import { RuntimeProviderError } from "../runtime-errors.js";
import type { SenderTurnOutput } from "../telagent/protocol/contract.js";
import { UserAuthenticationError } from "../authentication/types.js";
import { InMemoryConversationRepository } from "./in-memory-repository.js";
import {
  ConversationService,
  type ConversationAccessAuthorizer,
  type PrivateDraftTurnRuntime,
} from "./service.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const REPOSITORY = "1345851083";

const agentService = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness() {
  const completion = deferred<{
    provider: "codex";
    final: SenderTurnOutput;
    changedFiles: string[];
    exitCode: number;
    durationMs: number;
  }>();
  const authorizations: Array<{
    userId: string;
    repositoryId: string;
    conversationId: string;
    action: string;
  }> = [];
  let cancelled = false;
  const access: ConversationAccessAuthorizer = {
    async authorize(input) {
      authorizations.push({
        userId: input.authenticatedUserId,
        repositoryId: input.githubRepositoryId,
        conversationId: input.conversationId,
        action: input.action,
      });
    },
  };
  const runtime: PrivateDraftTurnRuntime = {
    async start() {
      return {
        turnId: "44444444-4444-4444-8444-444444444444",
        streamId: "55555555-5555-4555-8555-555555555555",
        initialState: "queued" as const,
        completion: completion.promise,
      };
    },
    async cancel() {
      cancelled = true;
      completion.reject(new Error("cancelled"));
      return true;
    },
  };
  let id = 0;
  const service = new ConversationService(
    new InMemoryConversationRepository(),
    access,
    runtime,
    {
      now: () => new Date("2026-08-30T12:00:00.000Z"),
      createId: () => `${String(++id).padStart(8, "0")}-0000-4000-8000-000000000000`,
    },
  );
  const authenticatedUserId = (request: FastifyRequest): string =>
    String(request.headers["x-test-user"] ?? "");
  return {
    service,
    completion,
    authorizations,
    wasCancelled: () => cancelled,
    authenticatedUserId,
  };
}

async function createDraft(
  app: Awaited<ReturnType<typeof createApp>>,
  userId = OWNER,
) {
  return app.inject({
    method: "POST",
    url: `/api/conversations/${CONVERSATION}/drafts`,
    headers: { "x-test-user": userId },
    payload: {
      githubRepositoryId: REPOSITORY,
      provider: "codex",
      roughMessage: "Ask how refresh token rotation works.",
    },
  });
}

describe("canonical conversation API", () => {
  it("uses route-level user identity instead of the legacy shared demo token", async () => {
    const test = harness();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      agentService,
      undefined,
      { service: test.service, authenticatedUserId: test.authenticatedUserId },
    );

    const canonical = await createDraft(app);
    expect(canonical.statusCode).toBe(201);

    const legacy = await app.inject({ method: "GET", url: "/api/agents" });
    expect(legacy.statusCode).toBe(401);
    await app.close();
  });

  it("returns a safe retryable error when verified identity is unavailable", async () => {
    const test = harness();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, undefined, {
      service: test.service,
      authenticatedUserId: async () => {
        throw new UserAuthenticationError(
          "AUTHENTICATION_UNAVAILABLE",
          "Telaegent sign-in is temporarily unavailable",
          503,
        );
      },
    });

    const response = await createDraft(app);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Telaegent sign-in is temporarily unavailable",
      code: "AUTHENTICATION_UNAVAILABLE",
      retryable: true,
    });
    await app.close();
  });

  it("runs a private draft, requires explicit Send, and appends exactly once", async () => {
    const test = harness();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, undefined, {
      service: test.service,
      authenticatedUserId: test.authenticatedUserId,
    });

    const created = await createDraft(app);
    expect(created.statusCode).toBe(201);
    const draftId = created.json().draft.draftId as string;

    const emptyConversation = await app.inject({
      method: "GET",
      url: `/api/conversations/${CONVERSATION}/messages?githubRepositoryId=${REPOSITORY}`,
      headers: { "x-test-user": OWNER },
    });
    expect(emptyConversation.json()).toEqual({ messages: [] });

    const started = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: {},
    });
    expect(started.statusCode).toBe(202);
    expect(started.json().pollUrl).toBe(`/api/drafts/${draftId}`);
    expect(started.json().draft).toMatchObject({
      state: "agent_working",
      turnId: "44444444-4444-4444-8444-444444444444",
    });

    test.completion.resolve({
      provider: "codex",
      final: {
        state: "ready",
        assistantMessage: "I prepared a focused question for Justin.",
        sendCandidate: "How does refresh token rotation work on your branch?",
        riskFlags: [],
        referencedPaths: [],
      },
      changedFiles: [],
      exitCode: 0,
      durationMs: 20,
    });
    await expect.poll(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/drafts/${draftId}`,
        headers: { "x-test-user": OWNER },
      });
      return response.json().draft.state;
    }).toBe("ready");

    const send = () =>
      app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/send`,
        headers: { "x-test-user": OWNER },
        payload: { idempotencyKey: "send-once" },
      });
    const first = await send();
    const replay = await send();
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      replayed: true,
      message: { messageId: first.json().message.messageId },
    });

    const shared = await app.inject({
      method: "GET",
      url: `/api/conversations/${CONVERSATION}/messages?githubRepositoryId=${REPOSITORY}`,
      headers: { "x-test-user": OWNER },
    });
    expect(shared.json().messages).toEqual([
      expect.objectContaining({
        body: "How does refresh token rotation work on your branch?",
        senderUserId: OWNER,
      }),
    ]);
    expect(test.authorizations.map((call) => call.action)).toEqual(
      expect.arrayContaining(["create_draft", "run_draft", "read", "send"]),
    );
    await app.close();
  });

  it("keeps a private draft invisible to another authenticated user", async () => {
    const test = harness();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, undefined, {
      service: test.service,
      authenticatedUserId: test.authenticatedUserId,
    });
    const created = await createDraft(app);
    const draftId = created.json().draft.draftId as string;

    const response = await app.inject({
      method: "GET",
      url: `/api/drafts/${draftId}`,
      headers: { "x-test-user": OTHER },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("refresh token");
    await app.close();
  });

  it("keeps clarification turns private and makes the draft runnable again", async () => {
    const test = harness();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, undefined, {
      service: test.service,
      authenticatedUserId: test.authenticatedUserId,
    });
    const created = await createDraft(app);
    const draftId = created.json().draft.draftId as string;
    await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: {},
    });
    test.completion.resolve({
      provider: "codex",
      final: {
        state: "needs_clarification",
        assistantMessage: "Do you need the API contract or implementation details?",
        sendCandidate: null,
        riskFlags: ["ambiguous_request"],
        referencedPaths: [],
      },
      changedFiles: [],
      exitCode: 0,
      durationMs: 20,
    });
    await expect.poll(() => test.service.getDraft(OWNER, draftId).then((draft) => draft.state)).toBe(
      "needs_clarification",
    );

    const clarified = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/messages`,
      headers: { "x-test-user": OWNER },
      payload: { content: "Only the public API contract." },
    });
    expect(clarified.statusCode).toBe(200);
    expect(clarified.json().draft).toMatchObject({
      state: "created",
      privateMessage: null,
      privateTurns: [
        {
          speaker: "agent",
          text: "Do you need the API contract or implementation details?",
        },
        { speaker: "owner", text: "Only the public API contract." },
      ],
    });

    const messages = await app.inject({
      method: "GET",
      url: `/api/conversations/${CONVERSATION}/messages?githubRepositoryId=${REPOSITORY}`,
      headers: { "x-test-user": OWNER },
    });
    expect(messages.json()).toEqual({ messages: [] });
    await app.close();
  });

  it("re-runs policy over human-edited content before sending", async () => {
    const test = harness();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, undefined, {
      service: test.service,
      authenticatedUserId: test.authenticatedUserId,
    });
    const created = await createDraft(app);
    const draftId = created.json().draft.draftId as string;
    await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: {},
    });
    test.completion.resolve({
      provider: "codex",
      final: {
        state: "ready",
        assistantMessage: "Ready for review.",
        sendCandidate: "Share the required environment variable names.",
        riskFlags: [],
        referencedPaths: [],
      },
      changedFiles: [],
      exitCode: 0,
      durationMs: 20,
    });
    await expect.poll(() => test.service.getDraft(OWNER, draftId).then((draft) => draft.state)).toBe("ready");

    const blocked = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/send`,
      headers: { "x-test-user": OWNER },
      payload: {
        approvedContent: "AWS_SECRET_ACCESS_KEY=example-secret-value",
        idempotencyKey: "unsafe-edit",
      },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({
      error: "Message blocked by policy",
      findings: [expect.objectContaining({ code: "GUARD_SECRET_VALUE_IN_CANDIDATE" })],
    });
    expect(blocked.body).not.toContain("example-secret-value");
    await app.close();
  });

  it("cancels an owner-scoped running draft without creating a message", async () => {
    const test = harness();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, undefined, {
      service: test.service,
      authenticatedUserId: test.authenticatedUserId,
    });
    const created = await createDraft(app);
    const draftId = created.json().draft.draftId as string;
    await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: {},
    });

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/cancel`,
      headers: { "x-test-user": OWNER },
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().draft.state).toBe("cancelled");
    expect(test.wasCancelled()).toBe(true);

    const messages = await app.inject({
      method: "GET",
      url: `/api/conversations/${CONVERSATION}/messages?githubRepositoryId=${REPOSITORY}`,
      headers: { "x-test-user": OWNER },
    });
    expect(messages.json()).toEqual({ messages: [] });
    await app.close();
  });

  it("exposes only normalized connector failures through private draft polling", async () => {
    const test = harness();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, undefined, {
      service: test.service,
      authenticatedUserId: test.authenticatedUserId,
    });
    const created = await createDraft(app);
    const draftId = created.json().draft.draftId as string;
    await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: {},
    });

    test.completion.reject(
      new RuntimeProviderError(
        "RUNTIME_UNAVAILABLE",
        "connector socket failed at C:\\private\\workspace",
      ),
    );

    await expect.poll(() => test.service.getDraft(OWNER, draftId)).toMatchObject({
      state: "runtime_failed",
      privateMessage: "Agent provider is temporarily unavailable",
      failure: {
        code: "RUNTIME_UNAVAILABLE",
        message: "Agent provider is temporarily unavailable",
        retryable: true,
      },
    });
    const polled = await app.inject({
      method: "GET",
      url: `/api/drafts/${draftId}`,
      headers: { "x-test-user": OWNER },
    });
    expect(polled.statusCode).toBe(200);
    expect(polled.body).not.toContain("private\\workspace");
    await app.close();
  });

  it("returns safe authorization denials without leaking internal reason codes", async () => {
    const test = harness();
    const deniedService = new ConversationService(
      new InMemoryConversationRepository(),
      {
        async authorize() {
          throw new PrivateRuntimeAuthorizationError(
            "PRIVATE_RUNTIME_FORBIDDEN",
            "project_connection_unavailable",
          );
        },
      },
      {
        async start() {
          throw new Error("must not run");
        },
        async cancel() {
          return false;
        },
      },
    );
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, undefined, {
      service: deniedService,
      authenticatedUserId: test.authenticatedUserId,
    });

    const denied = await createDraft(app);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "Private runtime is not authorized" });
    expect(denied.body).not.toContain("project_connection_unavailable");
    await app.close();
  });
});
