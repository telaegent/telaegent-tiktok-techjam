import { describe, expect, it, vi } from "vitest";
import { RunCancelledError } from "./errors.js";
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
  githubRepositoryId: "123",
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
    expect(started).toMatchObject({
      turnId: expect.any(String),
      streamId: expect.any(String),
      initialState: "queued",
    });
    expect(coordinator.status(started.turnId, scope)).toMatchObject({
      state: "queued",
      allowedActions: [],
    });
    const listener = vi.fn();
    const subscription = coordinator.subscribe(started.streamId, scope, listener);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(coordinator.status(started.turnId, scope)?.state).toBe("running");
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
      { type: "turn_completed", provider: "codex" },
    ]);
    expect(coordinator.status(started.turnId, scope)).toMatchObject({
      state: "completed",
      allowedActions: [],
    });
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
    expect(
      coordinator.status(started.turnId, { ...scope, userId: "user-b" }),
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
        progress: expect.objectContaining({
          type: "turn_failed",
          provider: "codex",
          failure: {
            code: "RUNTIME_AUTHENTICATION_FAILED",
            error: "Agent provider authentication is required",
            retryable: false,
          },
          allowedActions: ["reconnect_provider", "dismiss"],
        }),
      }),
    );
    expect(coordinator.status(started.turnId, scope)).toMatchObject({
      state: "failed",
      failure: { code: "RUNTIME_AUTHENTICATION_FAILED", retryable: false },
      allowedActions: ["reconnect_provider", "dismiss"],
    });
    expect(JSON.stringify(listener.mock.calls)).not.toContain(
      "secret provider detail",
    );
  });

  it("replaces a premature provider completion with the final managed outcome", async () => {
    const coordinator = new PrivateRuntimeTurnCoordinator(
      manager(async (_request, onProgress) => {
        onProgress?.({ type: "turn_completed", provider: "codex" });
        throw new RuntimeProviderError(
          "INVALID_AGENT_OUTPUT",
          "private malformed output detail",
        );
      }),
    );
    const started = coordinator.start(scope, request);
    const listener = vi.fn();
    coordinator.subscribe(started.streamId, scope, listener);

    await expect(started.completion).rejects.toMatchObject({
      code: "INVALID_AGENT_OUTPUT",
    });
    expect(listener.mock.calls.map(([event]) => event.progress.type)).toEqual([
      "turn_failed",
    ]);
  });

  it("distinguishes a safe timeout from an unknown provider failure", async () => {
    const coordinator = new PrivateRuntimeTurnCoordinator(
      manager(async () => {
        throw new RuntimeProviderError(
          "RUNTIME_TIMEOUT",
          "private provider timeout detail",
        );
      }),
    );
    const started = coordinator.start(scope, request);
    const listener = vi.fn();
    coordinator.subscribe(started.streamId, scope, listener);

    await expect(started.completion).rejects.toMatchObject({
      code: "RUNTIME_TIMEOUT",
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        progress: expect.objectContaining({
          type: "turn_timed_out",
          provider: "codex",
          failure: {
            code: "RUNTIME_TIMEOUT",
            error: "Agent runtime timed out",
            retryable: true,
          },
          allowedActions: ["retry", "edit_request", "dismiss"],
        }),
      }),
    );
    expect(JSON.stringify(listener.mock.calls)).not.toContain(
      "private provider timeout detail",
    );
  });

  it("only lets the owner cancel the active provider turn", async () => {
    let rejectTurn!: (reason: unknown) => void;
    const pending = new Promise<NormalizedRunResult>((_resolve, reject) => {
      rejectTurn = reject;
    });
    const run = vi.fn(() => pending);
    const canceller = {
      cancelMiddlewareTurn: vi.fn(async () => {
        rejectTurn(new RunCancelledError());
        return true;
      }),
    };
    const coordinator = new PrivateRuntimeTurnCoordinator(
      manager(run),
      new RuntimeProgressChannel(10),
      { canceller },
    );
    const started = coordinator.start(scope, request);
    const listener = vi.fn();
    coordinator.subscribe(started.streamId, scope, listener);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    await expect(
      coordinator.cancel(started.turnId, { ...scope, userId: "user-b" }),
    ).resolves.toBe(false);
    expect(canceller.cancelMiddlewareTurn).not.toHaveBeenCalled();

    await expect(coordinator.cancel(started.turnId, scope)).resolves.toBe(true);
    await expect(started.completion).rejects.toBeInstanceOf(RunCancelledError);
    expect(canceller.cancelMiddlewareTurn).toHaveBeenCalledWith(request.agentId);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        progress: expect.objectContaining({
          type: "turn_cancelled",
          provider: "codex",
          failure: {
            code: "RUNTIME_CANCELLED",
            error: "Agent provider turn was cancelled",
            retryable: false,
          },
          allowedActions: ["dismiss"],
        }),
      }),
    );
    expect(coordinator.status(started.turnId, scope)?.state).toBe("cancelled");
    await expect(coordinator.cancel(started.turnId, scope)).resolves.toBe(false);
  });

  it("cancels a queued turn without cancelling the active turn ahead of it", async () => {
    let finishFirst!: (value: NormalizedRunResult) => void;
    const firstPending = new Promise<NormalizedRunResult>((resolve) => {
      finishFirst = resolve;
    });
    const run = vi
      .fn<ProviderSessionRuntime["run"]>()
      .mockImplementationOnce(() => firstPending)
      .mockResolvedValueOnce(result());
    const canceller = { cancelMiddlewareTurn: vi.fn(async () => true) };
    const coordinator = new PrivateRuntimeTurnCoordinator(
      manager(run),
      new RuntimeProgressChannel(10),
      { canceller },
    );
    const first = coordinator.start(scope, request);
    const second = coordinator.start(scope, {
      ...request,
      correlationId: "correlation-2",
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    await expect(coordinator.cancel(second.turnId, scope)).resolves.toBe(true);
    expect(canceller.cancelMiddlewareTurn).not.toHaveBeenCalled();

    finishFirst(result());
    await first.completion;
    await expect(second.completion).rejects.toBeInstanceOf(RunCancelledError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retains terminal replay briefly, then removes the stream", async () => {
    let cleanup!: () => void;
    const scheduleCleanup = vi.fn((callback: () => void) => {
      cleanup = callback;
    });
    const coordinator = new PrivateRuntimeTurnCoordinator(
      manager(async (_request, onProgress) => {
        onProgress?.({ type: "turn_completed", provider: "codex" });
        return result();
      }),
      new RuntimeProgressChannel(10),
      { terminalRetentionMs: 5_000, scheduleCleanup },
    );
    const started = coordinator.start(scope, request);
    await started.completion;

    const lateSubscription = coordinator.subscribe(started.streamId, scope, vi.fn());
    expect(lateSubscription?.replay).toEqual([
      expect.objectContaining({
        progress: { type: "turn_completed", provider: "codex" },
      }),
    ]);
    expect(scheduleCleanup).toHaveBeenCalledWith(expect.any(Function), 5_000);

    cleanup();
    expect(coordinator.subscribe(started.streamId, scope, vi.fn())).toBeNull();
    expect(coordinator.status(started.turnId, scope)).toBeNull();
  });
});
