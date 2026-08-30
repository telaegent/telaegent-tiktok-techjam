import { describe, expect, it, vi } from "vitest";
import type {
  MiddlewareRunRequest,
  NormalizedRunResult,
} from "./runtime-contract.js";
import { RuntimeProviderError } from "./runtime-errors.js";
import {
  InMemoryProviderSessionStore,
  ProviderSessionManager,
  type ManagedAgentTurnRequest,
  type ProviderSessionRuntime,
  type ProviderSessionScope,
} from "./provider-session-manager.js";

const scope: ProviderSessionScope = {
  userId: "user-a",
  githubRepositoryId: 123,
  conversationId: "conversation-1",
  provider: "codex",
};

const turn: ManagedAgentTurnRequest = {
  agentId: "agent-a",
  purpose: "sender_draft",
  workspacePath: "C:\\workspace\\user-a\\repo-123",
  runtimePrompt: "Prepare the private draft",
  persistedSummary: "Private draft requested",
  sandboxMode: "read-only",
  networkMode: "none",
  outputSchemaName: "sender-draft.schema.json",
  correlationId: "correlation-1",
  maxTurns: 1,
};

function result(sessionId: string, final: unknown = { state: "ready" }): NormalizedRunResult {
  return {
    provider: "codex",
    sessionId,
    final,
    changedFiles: [],
    exitCode: 0,
    durationMs: 5,
  };
}

function runtime(
  implementation: (request: MiddlewareRunRequest) => Promise<NormalizedRunResult>,
): ProviderSessionRuntime & { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn(implementation) };
}

describe("ProviderSessionManager", () => {
  it("creates then resumes the session scoped to user, repo, conversation, and provider", async () => {
    const provider = runtime(async (request) =>
      result(request.sessionId ?? "session-a"),
    );
    const hydrate = vi.fn(async (_scope, request) => ({
      ...request,
      runtimePrompt: "Durable shared context\n" + request.runtimePrompt,
    }));
    const manager = new ProviderSessionManager(
      provider,
      new InMemoryProviderSessionStore(),
      hydrate,
    );

    await manager.run(scope, turn);
    await manager.run(scope, turn);

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(provider.run.mock.calls[0]?.[0]).toMatchObject({
      provider: "codex",
      sessionMode: "fresh",
      runtimePrompt: "Durable shared context\nPrepare the private draft",
    });
    expect(provider.run.mock.calls[1]?.[0]).toMatchObject({
      provider: "codex",
      sessionMode: "continue",
      sessionId: "session-a",
    });
  });

  it("never reuses a session across users, repositories, conversations, or providers", async () => {
    let sequence = 0;
    const provider = runtime(async (request) =>
      result(`${request.provider}-session-${++sequence}`),
    );
    const manager = new ProviderSessionManager(
      provider,
      new InMemoryProviderSessionStore(),
      async (_scope, request) => request,
    );
    const scopes: ProviderSessionScope[] = [
      scope,
      { ...scope, userId: "user-b" },
      { ...scope, githubRepositoryId: 456 },
      { ...scope, conversationId: "conversation-2" },
      { ...scope, provider: "claude" },
    ];

    for (const item of scopes) await manager.run(item, turn);

    expect(provider.run).toHaveBeenCalledTimes(5);
    for (const call of provider.run.mock.calls) {
      expect(call[0]).toMatchObject({ sessionMode: "fresh" });
      expect(call[0]).not.toHaveProperty("sessionId");
    }
  });

  it("rehydrates once into a fresh session when resume state disappears", async () => {
    let calls = 0;
    const provider = runtime(async (request) => {
      calls += 1;
      if (calls === 1) return result("lost-session");
      if (calls === 2) {
        throw new RuntimeProviderError(
          "RUNTIME_SESSION_NOT_FOUND",
          "Codex session is no longer available",
        );
      }
      return result("replacement-session");
    });
    const hydrate = vi.fn(async (_scope, request) => ({
      ...request,
      runtimePrompt: "Rehydrated from Telaegent memory",
    }));
    const store = new InMemoryProviderSessionStore();
    const manager = new ProviderSessionManager(provider, store, hydrate);

    await manager.run(scope, { ...turn, sessionMode: "fresh" });
    const recovered = await manager.run(scope, turn);

    expect(recovered).not.toHaveProperty("sessionId");
    expect(provider.run.mock.calls[1]?.[0]).toMatchObject({
      sessionMode: "continue",
      sessionId: "lost-session",
    });
    expect(provider.run.mock.calls[2]?.[0]).toMatchObject({
      sessionMode: "fresh",
      runtimePrompt: "Rehydrated from Telaegent memory",
    });
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect((await store.get(scope))?.sessionId).toBe("replacement-session");
  });

  it("does not retry ordinary runtime failures", async () => {
    const provider = runtime(async () => {
      throw new RuntimeProviderError("RUNTIME_FAILED", "Codex runtime failed");
    });
    const hydrate = vi.fn(async (_scope, request) => request);
    const manager = new ProviderSessionManager(
      provider,
      new InMemoryProviderSessionStore(),
      hydrate,
    );

    await expect(manager.run(scope, turn)).rejects.toMatchObject({
      code: "RUNTIME_FAILED",
    });
    expect(provider.run).toHaveBeenCalledTimes(1);
  });

  it("rejects and forgets an invalid provider session ID", async () => {
    const store = new InMemoryProviderSessionStore();
    const provider = runtime(async () => result("--not-a-provider-session"));
    const manager = new ProviderSessionManager(
      provider,
      store,
      async (_scope, request) => request,
    );

    await expect(manager.run(scope, turn)).rejects.toMatchObject({
      code: "INVALID_AGENT_OUTPUT",
    });
    expect(await store.get(scope)).toBeNull();
  });

  it("invalidates a stored session before the next turn", async () => {
    const store = new InMemoryProviderSessionStore();
    const provider = runtime(async (request) =>
      result(request.sessionId ?? "replacement-session"),
    );
    const hydrate = vi.fn(async (_scope, request) => request);
    const manager = new ProviderSessionManager(provider, store, hydrate);

    await manager.run(scope, turn);
    await manager.invalidate(scope);
    await manager.run(scope, turn);

    expect(provider.run.mock.calls[1]?.[0]).toMatchObject({
      sessionMode: "fresh",
    });
    expect(provider.run.mock.calls[1]?.[0]).not.toHaveProperty("sessionId");
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it("keeps ephemeral probes out of session memory", async () => {
    const store = new InMemoryProviderSessionStore();
    const provider = runtime(async () => result("ephemeral-session"));
    const hydrate = vi.fn(async (_scope, request) => request);
    const manager = new ProviderSessionManager(provider, store, hydrate);

    await manager.run(scope, { ...turn, sessionMode: "ephemeral" });

    expect(provider.run.mock.calls[0]?.[0]).toMatchObject({
      sessionMode: "ephemeral",
    });
    expect(await store.get(scope)).toBeNull();
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("serializes turns within one scope so concurrent resumes cannot race", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const provider = runtime(async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 1) await firstBlocked;
      active -= 1;
      return result("shared-session");
    });
    const manager = new ProviderSessionManager(
      provider,
      new InMemoryProviderSessionStore(),
      async (_scope, request) => request,
    );

    const first = manager.run(scope, turn);
    const second = manager.run(scope, turn);
    await vi.waitFor(() => expect(provider.run).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([first, second]);

    expect(maximumActive).toBe(1);
    expect(provider.run.mock.calls[1]?.[0]).toMatchObject({
      sessionMode: "continue",
      sessionId: "shared-session",
    });
  });
});
