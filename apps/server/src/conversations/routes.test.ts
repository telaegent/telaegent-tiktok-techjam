import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { AGENT_CLARIFICATION_LIMITS } from "../agent-clarification/contract.js";
import type { AgentService } from "../agent-service.js";
import { createApp } from "../app.js";
import { PrivateRuntimeAuthorizationError } from "../authorization/private-runtime-authorization.js";
import { loadConfig } from "../config.js";
import { RuntimeProviderError } from "../runtime-errors.js";
import type {
  RecipientTurnOutput,
  SenderTurnOutput,
} from "../telagent/protocol/contract.js";
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

type TurnCompletion = {
  provider: "codex";
  final: SenderTurnOutput | RecipientTurnOutput;
  changedFiles: string[];
  exitCode: number;
  durationMs: number;
};

function harness() {
  const completion = deferred<TurnCompletion>();
  // Each queued entry settles one `start`, in order. Tests that run a single
  // turn queue nothing and keep resolving `completion` directly.
  const queued: Array<ReturnType<typeof deferred<TurnCompletion>>> = [];
  const authorizations: Array<{
    userId: string;
    repositoryId: string;
    conversationId: string;
    action: string;
  }> = [];
  let cancelled = false;
  let starts = 0;
  // What each round was asked to run on, in order. `undefined` is a real
  // observation here: it is what a run with no chosen model must produce.
  const startedModels: (string | undefined)[] = [];
  const startedEfforts: (string | undefined)[] = [];
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
    async start(input) {
      starts += 1;
      startedModels.push(input.model);
      startedEfforts.push(input.effort);
      return {
        turnId: input.turnId ?? "44444444-4444-4444-8444-444444444444",
        streamId: "55555555-5555-4555-8555-555555555555",
        initialState: "queued" as const,
        completion: (queued.shift() ?? completion).promise,
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
      createTurnId: () => "44444444-4444-4444-8444-444444444444",
    },
  );
  const authenticatedUserId = (request: FastifyRequest): string =>
    String(request.headers["x-test-user"] ?? "");
  return {
    service,
    completion,
    queueTurn: () => {
      const next = deferred<TurnCompletion>();
      queued.push(next);
      return next;
    },
    authorizations,
    wasCancelled: () => cancelled,
    starts: () => starts,
    startedModels: () => startedModels,
    startedEfforts: () => startedEfforts,
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

describe("model and effort selection", () => {
  async function appWith(test: ReturnType<typeof harness>) {
    return createApp(loadConfig({ NODE_ENV: "test" }), agentService, undefined, {
      service: test.service,
      authenticatedUserId: test.authenticatedUserId,
    });
  }

  it("publishes a catalogue the picker can be built from", async () => {
    const test = harness();
    const app = await appWith(test);

    const response = await app.inject({
      method: "GET",
      url: `/api/runtime/models?githubRepositoryId=${REPOSITORY}`,
      headers: { "x-test-user": OWNER },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      // The picker has to know whether the bilateral clarification control
      // exists at all; the flag defaults off and this composition omits the
      // coordinator, so an absent field would read as enabled.
      agentClarificationEnabled: false,
      providers: [
        {
          provider: "claude",
          models: ["opus", "sonnet", "haiku", "fable"],
          defaultModel: "opus",
        },
        {
          provider: "codex",
          models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"],
          defaultModel: "gpt-5.6-sol",
        },
      ],
      // Reported once rather than per provider, because the rungs do not vary
      // by provider. A shape that repeated them under each entry would invite
      // a picker that filters them by provider for no reason.
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    });
  });

  it("publishes only providers live-probed by the selected repository connector", async () => {
    const test = harness();
    const availableProviders = vi.fn(() => ["codex"] as const);
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, undefined, {
      service: test.service,
      authenticatedUserId: test.authenticatedUserId,
      availableProviders,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/runtime/models?githubRepositoryId=${REPOSITORY}`,
      headers: { "x-test-user": OWNER },
    });

    expect(response.statusCode).toBe(200);
    expect(availableProviders).toHaveBeenCalledWith(OWNER, REPOSITORY);
    expect(response.json().providers).toEqual([
      {
        provider: "codex",
        models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"],
        defaultModel: "gpt-5.6-sol",
      },
    ]);
  });

  it("uses the signed-in web session instead of requiring the legacy API token", async () => {
    const test = harness();
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        APP_AUTH_TOKEN: "production-style-legacy-token",
      }),
      agentService,
      undefined,
      {
        service: test.service,
        authenticatedUserId: test.authenticatedUserId,
        availableProviders: () => ["codex"],
      },
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/runtime/models?githubRepositoryId=${REPOSITORY}`,
      headers: { "x-test-user": OWNER },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().providers).toEqual([
      expect.objectContaining({ provider: "codex" }),
    ]);
  });

  it("requires authentication for the catalogue", async () => {
    const test = harness();
    const app = await appWith(test);

    const response = await app.inject({ method: "GET", url: "/api/runtime/models" });

    expect(response.statusCode).toBe(401);
  });

  it("carries the chosen model into the turn", async () => {
    const test = harness();
    const app = await appWith(test);
    const draftId = (await createDraft(app)).json().draft.draftId as string;

    const response = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: { model: "gpt-5.5" },
    });

    expect(response.statusCode).toBe(202);
    expect(test.startedModels()).toEqual(["gpt-5.5"]);
  });

  it("leaves the model unset when the run does not choose one", async () => {
    const test = harness();
    const app = await appWith(test);
    const draftId = (await createDraft(app)).json().draft.draftId as string;

    // Both shapes an existing client sends: no body at all, and `{}`.
    const empty = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: {},
    });

    expect(empty.statusCode).toBe(202);
    expect(test.startedModels()).toEqual([undefined]);
  });

  it("carries the chosen effort into the turn", async () => {
    const test = harness();
    const app = await appWith(test);
    const draftId = (await createDraft(app)).json().draft.draftId as string;

    const response = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: { effort: "low" },
    });

    expect(response.statusCode).toBe(202);
    expect(test.startedEfforts()).toEqual(["low"]);
    // Independent choices: picking one must not imply the other.
    expect(test.startedModels()).toEqual([undefined]);
  });

  it("leaves the effort unset when the run does not choose one", async () => {
    const test = harness();
    const app = await appWith(test);
    const draftId = (await createDraft(app)).json().draft.draftId as string;

    const response = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: { model: "gpt-5.5" },
    });

    expect(response.statusCode).toBe(202);
    expect(test.startedEfforts()).toEqual([undefined]);
  });

  it("rejects an effort that is not on the ladder", async () => {
    const test = harness();
    const app = await appWith(test);
    const draftId = (await createDraft(app)).json().draft.draftId as string;

    // `xhigh` is a real rung on both CLIs. It is not offered, and "real" is
    // not the test -- neither CLI falls back, so only verified rungs ship.
    const response = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: { effort: "xhigh" },
    });

    expect(response.statusCode).toBe(400);
    expect(test.starts()).toBe(0);
  });

  it("does not leave a rejected effort's draft unrunnable", async () => {
    const test = harness();
    const app = await appWith(test);
    const draftId = (await createDraft(app)).json().draft.draftId as string;

    await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: { effort: "none" },
    });
    const retry = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: { model: "gpt-5.5", effort: "high" },
    });

    expect(retry.statusCode).toBe(202);
    expect(test.startedModels()).toEqual(["gpt-5.5"]);
    expect(test.startedEfforts()).toEqual(["high"]);
  });

  it("rejects a model this draft's provider does not offer", async () => {
    const test = harness();
    const app = await appWith(test);
    // The draft is Codex. `opus` is a real model -- just not this provider's.
    const draftId = (await createDraft(app)).json().draft.draftId as string;

    const response = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: { model: "opus" },
    });

    expect(response.statusCode).toBe(400);
    expect(test.starts()).toBe(0);
  });

  it("rejects a model that is not in any catalogue", async () => {
    const test = harness();
    const app = await appWith(test);
    const draftId = (await createDraft(app)).json().draft.draftId as string;

    const response = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: { model: "not-a-real-model" },
    });

    expect(response.statusCode).toBe(400);
    expect(test.starts()).toBe(0);
  });

  it("rejects unknown fields on the run body", async () => {
    const test = harness();
    const app = await appWith(test);
    const draftId = (await createDraft(app)).json().draft.draftId as string;

    const response = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: { model: "gpt-5.5", provider: "claude" },
    });

    expect(response.statusCode).toBe(400);
    expect(test.starts()).toBe(0);
  });

  it("does not leave a rejected model's draft unrunnable", async () => {
    const test = harness();
    const app = await appWith(test);
    const draftId = (await createDraft(app)).json().draft.draftId as string;

    await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: { model: "opus" },
    });
    // The draft was never claimed, so a corrected retry must still work rather
    // than meeting the 409 a claimed-then-abandoned draft would produce.
    const retry = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: { model: "gpt-5.5" },
    });

    expect(retry.statusCode).toBe(202);
    expect(test.startedModels()).toEqual(["gpt-5.5"]);
  });
});

describe("canonical conversation API", () => {
  it("claims a draft before dispatch so concurrent run requests launch one provider turn", async () => {
    const test = harness();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, undefined, {
      service: test.service,
      authenticatedUserId: test.authenticatedUserId,
    });
    const created = await createDraft(app);
    const draftId = created.json().draft.draftId as string;

    const [left, right] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/run`,
        headers: { "x-test-user": OWNER },
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/run`,
        headers: { "x-test-user": OWNER },
        payload: {},
      }),
    ]);

    expect([left.statusCode, right.statusCode].sort()).toEqual([202, 409]);
    expect(test.starts()).toBe(1);
    test.completion.resolve({
      provider: "codex",
      final: {
        state: "blocked",
        assistantMessage: "Stopped after the concurrency proof.",
        sendCandidate: null,
        riskFlags: [],
        referencedPaths: [],
      },
      changedFiles: [],
      exitCode: 0,
      durationMs: 1,
    });
    await app.close();
  });

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
    expect(created.headers["cache-control"]).toBe("no-store, max-age=0");
    const draftId = created.json().draft.draftId as string;

    const emptyConversation = await app.inject({
      method: "GET",
      url: `/api/conversations/${CONVERSATION}/messages?githubRepositoryId=${REPOSITORY}`,
      headers: { "x-test-user": OWNER },
    });
    expect(emptyConversation.json()).toEqual({
      messages: [],
      nextCursor: null,
      pollCursor: null,
    });
    expect(emptyConversation.headers["cache-control"]).toBe(
      "no-store, max-age=0",
    );

    const started = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: {},
    });
    expect(started.statusCode).toBe(202);
    expect(started.headers["cache-control"]).toBe("no-store, max-age=0");
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
    expect(shared.json().pollCursor).toEqual(expect.any(String));
    const unchanged = await app.inject({
      method: "GET",
      url:
        `/api/conversations/${CONVERSATION}/messages?githubRepositoryId=${REPOSITORY}` +
        `&cursor=${encodeURIComponent(shared.json().pollCursor)}`,
      headers: { "x-test-user": OWNER },
    });
    expect(unchanged.json()).toEqual({
      messages: [],
      nextCursor: null,
      pollCursor: shared.json().pollCursor,
    });
    expect(test.authorizations.map((call) => call.action)).toEqual(
      expect.arrayContaining(["create_draft", "run_draft", "read", "send"]),
    );
    await app.close();
  });

  it("recovers only the authenticated owner's unfinished drafts in this scope", async () => {
    const test = harness();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, undefined, {
      service: test.service,
      authenticatedUserId: test.authenticatedUserId,
    });

    const owned = await createDraft(app, OWNER);
    await createDraft(app, OTHER);
    const response = await app.inject({
      method: "GET",
      url: `/api/conversations/${CONVERSATION}/drafts?githubRepositoryId=${REPOSITORY}`,
      headers: { "x-test-user": OWNER },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.json().drafts).toEqual([
      expect.objectContaining({ draftId: owned.json().draft.draftId }),
    ]);
    await app.close();
  });

  it("completes the round trip: an approved message opens the recipient's own gated draft", async () => {
    const test = harness();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, undefined, {
      service: test.service,
      authenticatedUserId: test.authenticatedUserId,
    });

    const senderTurn = test.queueTurn();
    const recipientTurn = test.queueTurn();

    const created = await createDraft(app);
    const senderDraftId = created.json().draft.draftId as string;
    expect(created.json().draft).toMatchObject({
      role: "sender",
      incomingMessageId: null,
    });

    await app.inject({
      method: "POST",
      url: `/api/drafts/${senderDraftId}/run`,
      headers: { "x-test-user": OWNER },
      payload: {},
    });
    senderTurn.resolve({
      provider: "codex",
      final: {
        state: "ready",
        assistantMessage: "I prepared a focused question.",
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
        url: `/api/drafts/${senderDraftId}`,
        headers: { "x-test-user": OWNER },
      });
      return response.json().draft.state;
    }).toBe("ready");

    const sent = await app.inject({
      method: "POST",
      url: `/api/drafts/${senderDraftId}/send`,
      headers: { "x-test-user": OWNER },
      payload: { idempotencyKey: "send-question" },
    });
    expect(sent.statusCode).toBe(201);
    const incomingMessageId = sent.json().message.messageId as string;

    // An owner answers a collaborator, never themselves.
    const selfReply = await app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION}/replies`,
      headers: { "x-test-user": OWNER },
      payload: {
        githubRepositoryId: REPOSITORY,
        provider: "codex",
        incomingMessageId,
        idempotencyKey: "reply-self-1",
      },
    });
    expect(selfReply.statusCode).toBe(409);
    expect(JSON.stringify(selfReply.json())).not.toContain("sender_user_id");

    const reply = await app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION}/replies`,
      headers: { "x-test-user": OTHER },
      payload: {
        githubRepositoryId: REPOSITORY,
        provider: "codex",
        incomingMessageId,
        ownerGuidance: "keep it short",
        idempotencyKey: "reply-other-1",
      },
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(reply.json().draft).toMatchObject({
      role: "recipient",
      incomingMessageId,
      // Steering on top of the message, not a rough ask of the owner's own.
      roughMessage: "keep it short",
      privateTurns: [{ speaker: "owner", text: "keep it short" }],
      state: "created",
    });
    const replyDraftId = reply.json().draft.draftId as string;

    const replayedReply = await app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION}/replies`,
      headers: { "x-test-user": OTHER },
      payload: {
        githubRepositoryId: REPOSITORY,
        provider: "codex",
        incomingMessageId,
        ownerGuidance: "keep it short",
        idempotencyKey: "reply-other-1",
      },
    });
    expect(replayedReply.statusCode).toBe(200);
    expect(replayedReply.json()).toMatchObject({
      replayed: true,
      draft: { draftId: replyDraftId },
    });

    const conflictingReplay = await app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION}/replies`,
      headers: { "x-test-user": OTHER },
      payload: {
        githubRepositoryId: REPOSITORY,
        provider: "codex",
        incomingMessageId,
        ownerGuidance: "include every implementation detail",
        idempotencyKey: "reply-other-1",
      },
    });
    expect(conflictingReplay.statusCode).toBe(409);

    // The reply is a private draft like any other: invisible to the collaborator
    // who triggered it, and it still leaves only through Send.
    const peek = await app.inject({
      method: "GET",
      url: `/api/drafts/${replyDraftId}`,
      headers: { "x-test-user": OWNER },
    });
    expect(peek.statusCode).toBe(404);

    await app.inject({
      method: "POST",
      url: `/api/drafts/${replyDraftId}/run`,
      headers: { "x-test-user": OTHER },
      payload: {},
    });
    recipientTurn.resolve({
      provider: "codex",
      final: {
        state: "ready",
        privateSummary: "Checked the auth module before answering.",
        sendCandidate: "Rotation happens on every refresh, server side.",
        riskFlags: [],
        sourcePaths: [],
      },
      changedFiles: [],
      exitCode: 0,
      durationMs: 20,
    });
    await expect.poll(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/drafts/${replyDraftId}`,
        headers: { "x-test-user": OTHER },
      });
      return response.json().draft.state;
    }).toBe("ready");

    const answered = await app.inject({
      method: "POST",
      url: `/api/drafts/${replyDraftId}/send`,
      headers: { "x-test-user": OTHER },
      payload: { idempotencyKey: "send-answer" },
    });
    expect(answered.statusCode).toBe(201);

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
      expect.objectContaining({
        body: "Rotation happens on every refresh, server side.",
        senderUserId: OTHER,
      }),
    ]);
    // The reply crossed the boundary under its own human gate, not the sender's.
    expect(test.authorizations.map((call) => call.action)).toEqual(
      expect.arrayContaining(["create_draft", "create_reply", "run_draft", "send"]),
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
    expect(messages.json()).toEqual({
      messages: [],
      nextCursor: null,
      pollCursor: null,
    });
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
    expect(messages.json()).toEqual({
      messages: [],
      nextCursor: null,
      pollCursor: null,
    });
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
    expect(denied.json()).toEqual({
      error: "Private runtime is not authorized",
      code: "PRIVATE_RUNTIME_FORBIDDEN",
      retryable: false,
    });
    expect(denied.body).not.toContain("project_connection_unavailable");
    await app.close();
  });

  it("makes a stale repository proof safely retryable", async () => {
    const test = harness();
    const deniedService = new ConversationService(
      new InMemoryConversationRepository(),
      {
        async authorize() {
          throw new PrivateRuntimeAuthorizationError(
            "PRIVATE_RUNTIME_FORBIDDEN",
            "repository_access_stale",
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
    expect(denied.json()).toEqual({
      error: "Private runtime is not authorized",
      code: "PRIVATE_RUNTIME_FORBIDDEN",
      retryable: true,
    });
    expect(denied.body).not.toContain("repository_access_stale");
    await app.close();
  });
});

describe("a human answer to an agent clarification", () => {
  const TASK = "44444444-4444-4444-8444-444444444444";
  const STEP = "55555555-5555-4555-8555-555555555555";

  async function continueWith(answer: string) {
    const test = harness();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, undefined, {
      service: test.service,
      authenticatedUserId: test.authenticatedUserId,
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/agent-clarifications/${TASK}/continue`,
      headers: { "x-test-user": OWNER },
      payload: { currentStepId: STEP, expectedVersion: 1, answer },
    });
    await app.close();
    return response;
  }

  it("refuses an over-long answer where it arrives, not where it is stored", async () => {
    // The route used to bound this at 2000 characters while the contract and
    // the SQL check bound it at 1500 UTF-8 bytes, so an over-length answer was
    // accepted at the edge and refused in the database -- reaching the person
    // as a generic 409 that reads as "the task moved on". Bilingual
    // conversations hit it first: Vietnamese and CJK text spends two to three
    // bytes a character, so the byte ceiling arrives while the character count
    // still looks small.
    const answer = String.fromCharCode(0x0111).repeat(800);
    expect(answer.length).toBeLessThan(AGENT_CLARIFICATION_LIMITS.maxAnswerBytes);
    expect(Buffer.byteLength(answer, "utf8")).toBeGreaterThan(
      AGENT_CLARIFICATION_LIMITS.maxAnswerBytes,
    );

    expect((await continueWith(answer)).statusCode).toBe(400);
  });

  it("lets an answer that exactly spends the byte budget reach the service", async () => {
    // This composition carries no coordinator, so passing validation is visible
    // as the service's own 404 rather than as a 400 from the schema. That is
    // the difference the test above depends on.
    const answer = "a".repeat(AGENT_CLARIFICATION_LIMITS.maxAnswerBytes);
    expect((await continueWith(answer)).statusCode).toBe(404);
  });
});
