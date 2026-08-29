import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import type {
  AgentServiceRuntimeOptions,
  MiddlewareProviderRunner,
  MiddlewareRunRequest,
  NormalizedRunResult,
  RuntimeProgressEvent,
} from "./runtime-contract.js";
import { RuntimeProviderRegistry } from "./runtime-provider-registry.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

class PlaygroundRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return { output: request.prompt, threadId: "playground-thread", usage: null };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const middlewareRequest = (
  agentId: string,
  workspacePath: string,
  overrides: Partial<MiddlewareRunRequest> = {},
): MiddlewareRunRequest => ({
  agentId,
  provider: "codex",
  purpose: "status",
  workspacePath,
  runtimePrompt: "PRIVATE_RUNTIME_PROMPT",
  persistedSummary: "Safe status summary",
  sessionMode: "fresh",
  sandboxMode: "read-only",
  networkMode: "default",
  outputSchemaName: "status.schema.json",
  correlationId: "corr-1",
  maxTurns: 2,
  ...overrides,
});

async function makeService(
  runner: MiddlewareProviderRunner,
  runtimeOptions: AgentServiceRuntimeOptions = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "telagent-runtime-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    new PlaygroundRunner(),
    new RuntimeProviderRegistry([runner], {
      resolve: async () => ({ type: "object" }),
    }),
    runtimeOptions,
  );
  await service.initialize();
  return { service, store };
}

describe("AgentService middleware turns", () => {
  it("returns the candidate without persisting private prompt or raw output", async () => {
    const runner: MiddlewareProviderRunner = {
      provider: "codex",
      runStructured: async () => ({
        provider: "codex",
        final: { privateCandidate: "RAW_PROVIDER_OUTPUT" },
        changedFiles: [],
        exitCode: 0,
        durationMs: 5,
      }),
      cancel: async () => false,
      capability: async () => ({ installed: true, authenticated: true, reason: null }),
    };
    const { service, store } = await makeService(runner);
    const agent = await service.createAgent({ name: "Bob" });
    const result = await service.runMiddlewareTurn(
      middlewareRequest(agent.id, agent.workspacePath),
    );

    expect(result.final).toEqual({ privateCandidate: "RAW_PROVIDER_OUTPUT" });
    expect(service.getMessages(agent.id)).toEqual([]);
    expect(service.getRuns(agent.id)).toMatchObject([
      { prompt: "Safe status summary", output: null, status: "completed" },
    ]);
    const persisted = JSON.stringify(store.snapshot());
    expect(persisted).not.toContain("PRIVATE_RUNTIME_PROMPT");
    expect(persisted).not.toContain("RAW_PROVIDER_OUTPUT");
  });

  it("shares the busy lock with normal Playground runs", async () => {
    let finish!: (result: NormalizedRunResult) => void;
    const pending = new Promise<NormalizedRunResult>((resolve) => {
      finish = resolve;
    });
    const runner: MiddlewareProviderRunner = {
      provider: "codex",
      runStructured: () => pending,
      cancel: async () => false,
      capability: async () => ({ installed: true, authenticated: true, reason: null }),
    };
    const { service } = await makeService(runner);
    const agent = await service.createAgent({ name: "Busy Bob" });
    const active = service.runMiddlewareTurn(
      middlewareRequest(agent.id, agent.workspacePath),
    );
    await expect.poll(() => service.getAgent(agent.id).status).toBe("busy");

    await expect(service.sendMessage(agent.id, "normal run")).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      service.runMiddlewareTurn(middlewareRequest(agent.id, agent.workspacePath)),
    ).rejects.toMatchObject({ statusCode: 409 });

    finish({
      provider: "codex",
      final: { publicSummary: "done" },
      changedFiles: [],
      exitCode: 0,
      durationMs: 5,
    });
    await active;
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("updates persistent Codex sessions but not ephemeral sessions", async () => {
    let sessionId = "session-one";
    const runner: MiddlewareProviderRunner = {
      provider: "codex",
      runStructured: async () => ({
        provider: "codex",
        sessionId,
        final: { publicSummary: "done" },
        changedFiles: [],
        exitCode: 0,
        durationMs: 5,
      }),
      cancel: async () => false,
      capability: async () => ({ installed: true, authenticated: true, reason: null }),
    };
    const { service } = await makeService(runner);
    const agent = await service.createAgent({ name: "Session Bob" });
    await service.runMiddlewareTurn(
      middlewareRequest(agent.id, agent.workspacePath, { sessionMode: "continue" }),
    );
    expect(service.getAgent(agent.id).codexThreadId).toBe("session-one");

    sessionId = "detached-session";
    await service.runMiddlewareTurn(
      middlewareRequest(agent.id, agent.workspacePath, { sessionMode: "fresh" }),
    );
    expect(service.getAgent(agent.id).codexThreadId).toBe("detached-session");

    sessionId = "ephemeral-session";
    await service.runMiddlewareTurn(
      middlewareRequest(agent.id, agent.workspacePath, { sessionMode: "ephemeral" }),
    );
    expect(service.getAgent(agent.id).codexThreadId).toBe("detached-session");
  });

  it("forwards provider progress to lifecycle and the managed-turn caller", async () => {
    const lifecycleProgress: RuntimeProgressEvent[] = [];
    const callerProgress: RuntimeProgressEvent[] = [];
    const runner: MiddlewareProviderRunner = {
      provider: "codex",
      runStructured: async (_request, _schema, onProgress) => {
        onProgress?.({ type: "turn_started", provider: "codex" });
        onProgress?.({ type: "text_delta", provider: "codex", text: "Working" });
        return {
          provider: "codex",
          final: { state: "ready" },
          changedFiles: [],
          exitCode: 0,
          durationMs: 5,
        };
      },
      cancel: async () => false,
      capability: async () => ({ installed: true, authenticated: true, reason: null }),
    };
    const { service } = await makeService(runner, {
      lifecycle: {
        onRuntimeProgress: ({ progress: event }) => lifecycleProgress.push(event),
      },
    });
    const agent = await service.createAgent({ name: "Streaming Bob" });

    await service.runMiddlewareTurn(
      middlewareRequest(agent.id, agent.workspacePath),
      (event) => callerProgress.push(event),
    );

    expect(lifecycleProgress).toEqual([
      { type: "turn_started", provider: "codex" },
      { type: "text_delta", provider: "codex", text: "Working" },
    ]);
    expect(callerProgress).toEqual(lifecycleProgress);
  });

  it("cancels a middleware turn without stopping the Agent", async () => {
    let rejectTurn!: (reason: unknown) => void;
    const pending = new Promise<NormalizedRunResult>((_resolve, reject) => {
      rejectTurn = reject;
    });
    const runner: MiddlewareProviderRunner = {
      provider: "codex",
      runStructured: () => pending,
      cancel: async (agentId) => {
        rejectTurn(new RunCancelledError());
        return Boolean(agentId);
      },
      capability: async () => ({ installed: true, authenticated: true, reason: null }),
    };
    const { service } = await makeService(runner);
    const agent = await service.createAgent({ name: "Cancelable Bob" });
    const active = service.runMiddlewareTurn(
      middlewareRequest(agent.id, agent.workspacePath),
    );
    await expect.poll(() => service.getAgent(agent.id).status).toBe("busy");

    await expect(service.cancelMiddlewareTurn(agent.id)).resolves.toBe(true);
    await expect(active).rejects.toBeInstanceOf(RunCancelledError);
    expect(service.getAgent(agent.id).status).toBe("ready");
    expect(service.getRuns(agent.id)[0]).toMatchObject({
      status: "cancelled",
      error: "Run cancelled",
    });
    await expect(service.cancelMiddlewareTurn(agent.id)).resolves.toBe(false);
  });

  it("rejects cross-workspace and writable planning requests before execution", async () => {
    let calls = 0;
    const runner: MiddlewareProviderRunner = {
      provider: "codex",
      runStructured: async () => {
        calls += 1;
        throw new Error("must not run");
      },
      cancel: async () => false,
      capability: async () => ({ installed: true, authenticated: true, reason: null }),
    };
    const { service } = await makeService(runner);
    const agent = await service.createAgent({ name: "Guarded Bob" });

    await expect(
      service.runMiddlewareTurn(
        middlewareRequest(agent.id, path.join(agent.workspacePath, "other")),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.runMiddlewareTurn(
        middlewareRequest(agent.id, agent.workspacePath, {
          sandboxMode: "workspace-write",
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toBe(0);
    expect(service.getRuns(agent.id)).toEqual([]);
  });

  it("redacts unknown provider failures before persistence", async () => {
    const runner: MiddlewareProviderRunner = {
      provider: "codex",
      runStructured: async () => {
        throw new Error("401 invalid API key SUPER-SECRET and C:\\private\\path");
      },
      cancel: async () => false,
      capability: async () => ({ installed: true, authenticated: true, reason: null }),
    };
    const { service, store } = await makeService(runner);
    const agent = await service.createAgent({ name: "Safe Bob" });

    await expect(
      service.runMiddlewareTurn(middlewareRequest(agent.id, agent.workspacePath)),
    ).rejects.toThrow("Agent runtime failed");
    const persisted = JSON.stringify(store.snapshot());
    expect(persisted).not.toContain("SUPER-SECRET");
    expect(persisted).not.toContain("private\\path");
    expect(service.getRuns(agent.id)[0]?.error).toBe("Agent runtime failed");
  });
});
