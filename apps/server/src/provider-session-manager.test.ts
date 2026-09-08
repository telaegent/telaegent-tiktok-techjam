import { describe, expect, it, vi } from "vitest";
import type {
  MiddlewareRunRequest,
  NormalizedRunResult,
} from "./runtime-contract.js";
import {
  RuntimeProviderError,
  classifyProviderFailure,
} from "./runtime-errors.js";
import { RunCancelledError } from "./errors.js";
import {
  InMemoryProviderSessionStore,
  ProviderSessionManager,
  type ManagedAgentTurnRequest,
  type ProviderSessionRuntime,
  type ProviderSessionScope,
} from "./provider-session-manager.js";

const scope: ProviderSessionScope = {
  userId: "user-a",
  githubRepositoryId: "123",
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
      { ...scope, githubRepositoryId: "456" },
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
        throw classifyProviderFailure(
          "claude",
          "No conversation found with session ID: private-session-id",
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

  it("does not start a queued provider turn after its cancellation signal fires", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const provider = runtime(async () => {
      calls += 1;
      if (calls === 1) await firstBlocked;
      return result("shared-session");
    });
    const manager = new ProviderSessionManager(
      provider,
      new InMemoryProviderSessionStore(),
      async (_scope, request) => request,
    );
    const controller = new AbortController();

    const first = manager.run(scope, turn);
    const second = manager.run(
      scope,
      turn,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    await vi.waitFor(() => expect(provider.run).toHaveBeenCalledTimes(1));
    controller.abort();
    releaseFirst();

    await expect(first).resolves.toBeDefined();
    await expect(second).rejects.toBeInstanceOf(RunCancelledError);
    expect(provider.run).toHaveBeenCalledTimes(1);
  });
});

/**
 * Plan section 7.2 scope isolation.
 *
 * The dialogue lane is the one place a participant's agent answers on behalf of
 * a peer, and it runs with no tools and only approved context. If it could
 * resume the same provider session as that participant's `private_work` turn,
 * the no-tools promise would be worth nothing: the provider would still be
 * carrying the repository-aware conversation in its own memory.
 */
describe("ProviderSessionManager task lanes", () => {
  const taskScope: ProviderSessionScope = {
    ...scope,
    taskId: "task-1",
    peerUserId: "user-b",
    lane: "private_work",
    participantRole: "responder",
    stepId: "step-1",
  };

  function sessions(): {
    manager: ProviderSessionManager;
    provider: ReturnType<typeof runtime>;
  } {
    let sequence = 0;
    const provider = runtime(async (request) =>
      result(request.sessionId ?? `session-${++sequence}`),
    );
    return {
      provider,
      manager: new ProviderSessionManager(
        provider,
        new InMemoryProviderSessionStore(),
        async (_scope, request) => request,
      ),
    };
  }

  it("never lets a dialogue turn resume the private_work session", async () => {
    const { manager, provider } = sessions();

    await manager.run(taskScope, turn);
    await manager.run({ ...taskScope, lane: "clarification_dialogue" }, turn);

    expect(provider.run).toHaveBeenCalledTimes(2);
    for (const call of provider.run.mock.calls) {
      expect(call[0]).toMatchObject({ sessionMode: "fresh" });
      expect(call[0]).not.toHaveProperty("sessionId");
    }
  });

  it("keeps one dialogue session across the steps of a single task", async () => {
    // The envelope's `stepId` and `participantRole` are labels derived from the
    // task, not key material. Re-keying on them would restart the peer agent
    // between a question and its answer and lose the exchange it just had.
    const dialogue = { ...taskScope, lane: "clarification_dialogue" as const };
    const { manager, provider } = sessions();

    await manager.run(dialogue, turn);
    await manager.run(
      { ...dialogue, participantRole: "requester", stepId: "step-2" },
      turn,
    );

    expect(provider.run.mock.calls[1]?.[0]).toMatchObject({
      sessionMode: "continue",
      sessionId: "session-1",
    });
  });

  it("never shares a session across tasks, peers, or models", async () => {
    const { manager, provider } = sessions();
    const scopes: ProviderSessionScope[] = [
      taskScope,
      { ...taskScope, taskId: "task-2" },
      { ...taskScope, peerUserId: "user-c" },
      { ...taskScope, model: "sonnet" },
    ];

    for (const item of scopes) await manager.run(item, turn);

    expect(provider.run).toHaveBeenCalledTimes(4);
    for (const call of provider.run.mock.calls) {
      expect(call[0]).toMatchObject({ sessionMode: "fresh" });
    }
  });

  it("leaves a legacy conversation-scoped session untouched by task scopes", async () => {
    // Old private drafts omit every task field, and a task-scoped turn must
    // neither resume nor evict the session they already own.
    const { manager, provider } = sessions();

    await manager.run(scope, turn);
    await manager.run(taskScope, turn);
    await manager.run(scope, turn);

    expect(provider.run.mock.calls[1]?.[0]).toMatchObject({
      sessionMode: "fresh",
    });
    expect(provider.run.mock.calls[2]?.[0]).toMatchObject({
      sessionMode: "continue",
      sessionId: "session-1",
    });
  });

  it("rejects a lane or participant role outside the closed sets", async () => {
    const { manager, provider } = sessions();

    await expect(
      manager.run(
        { ...taskScope, lane: "repository_work" as never },
        turn,
      ),
    ).rejects.toThrow("Provider session scope is invalid");
    await expect(
      manager.run(
        { ...taskScope, participantRole: "observer" as never },
        turn,
      ),
    ).rejects.toThrow("Provider session scope is invalid");

    expect(provider.run).not.toHaveBeenCalled();
  });
});
