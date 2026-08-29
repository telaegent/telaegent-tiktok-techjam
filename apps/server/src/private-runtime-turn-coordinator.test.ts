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
import { PrivateRuntimeTurnCoordinator } from "./private-runtime-turn-coordinator.js";
import { RuntimeProgressChannel } from "./runtime-progress-channel.js";

const scope: ProviderSessionScope = {
  userId: "user-a",
  repositoryId: "repo-123",
  conversationId: "conversation-1",
  provider: "codex",
};

const request: ManagedAgentTurnRequest = {
  agentId: "agent-a",
  purpose: "sender_draft",
  workspacePath: "C:\\runtime\\user-a\\repo-123",
  runtimePrompt: "Prepare a private draft",
  persistedSummary: "Private draft requested",
  sandboxMode: "read-only",
  networkMode: "none",
  outputSchemaName: "sender-draft.schema.json",
  correlationId: "correlation-1",
  maxTurns: 1,
};

function manager(
  run: ProviderSessionRuntime["run"],
): ProviderSessionManager {
  return new ProviderSessionManager(
    { run },
    new InMemoryProviderSessionStore(),
    async (_scope, turn) => turn,
  );
}

function result(): NormalizedRunResult {
  return {
    provider: "codex",
    sessionId: "private-provider-session",
    final: { state: "ready" },
    changedFiles: [],
    exitCode: 0,
    durationMs: 5,
  };
}

describe("PrivateRuntimeTurnCoordinator", () => {
  it("returns a stream immediately and forwards safe progress until completion", async () => {
    let finish!: (value: NormalizedRunResult) => void;
    let emitProgress!: NonNullable<Parameters<ProviderSessionRuntime["run"]>[1]>;
    const pending = new Promise<NormalizedRunResult>((resolve) => {
      finish = resolve;
    });
    const run = vi.fn(
      async (_turn: MiddlewareRunRequest, onProgress?: typeof emitProgress) => {
        if (onProgress) emitProgress = onProgress;
        return pending;
      },
    );
    const coordinator = new PrivateRuntimeTurnCoordinator(
      manager(run),
      new RuntimeProgressChannel(10),
    );

    const started = coordinator.start(scope, request);
    const listener = vi.fn();
    const subscription = coordinator.subscribe(started.streamId, scope, listener);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    emitProgress({ type: "turn_started", provider: "codex" });
    emitProgress({ type: "text_delta", provider: "codex", text: "Working" });
    finish(result());

    await expect(started.completion).resolves.toEqual({
      provider: "codex",
      final: { state: "ready" },
      changedFiles: [],
      exitCode: 0,
      durationMs: 5,
    });
    expect(subscription).not.toBeNull();
    expect(listener.mock.calls.map(([event]) => event.progress)).toEqual([
      { type: "turn_started", provider: "codex" },
      { type: "text_delta", provider: "codex", text: "Working" },
    ]);
  });

  it("rejects a different owner even when the stream ID is known", () => {
    const coordinator = new PrivateRuntimeTurnCoordinator(
      manager(async () => result()),
    );
    const started = coordinator.start(scope, request);

    expect(
      coordinator.subscribe(
        started.streamId,
        { ...scope, userId: "user-b" },
        vi.fn(),
      ),
    ).toBeNull();
    return started.completion;
  });

  it("publishes a provider-neutral failure without leaking the provider error", async () => {
    const coordinator = new PrivateRuntimeTurnCoordinator(
      manager(async () => {
        throw new RuntimeProviderError(
          "RUNTIME_AUTHENTICATION_FAILED",
          "secret provider detail",
        );
      }),
    );
    const started = coordinator.start(scope, request);
    const listener = vi.fn();
    coordinator.subscribe(started.streamId, scope, listener);

    await expect(started.completion).rejects.toMatchObject({
      code: "RUNTIME_AUTHENTICATION_FAILED",
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        progress: { type: "turn_failed", provider: "codex" },
      }),
    );
    expect(JSON.stringify(listener.mock.calls)).not.toContain(
      "secret provider detail",
    );
  });
});
