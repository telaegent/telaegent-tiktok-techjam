import { describe, expect, it, vi } from "vitest";
import type { ManagedAgentTurnRequest } from "../provider-session-manager.js";
import {
  ConnectorTurnExecutor,
  connectorJobTimeoutMs,
  type ConnectorJobRelay,
} from "./connector-turn-executor.js";

const scope = {
  userId: "user-1",
  githubRepositoryId: "1345851083",
  conversationId: "conversation-1",
  provider: "codex" as const,
};

function request(): ManagedAgentTurnRequest {
  return {
    agentId: "connector-binding-1",
    connectorBindingId: "connector-binding-1",
    purpose: "sender_draft",
    runtimePrompt: "Prepare a bounded draft.",
    persistedSummary: "Approved shared context only.",
    sessionMode: "continue",
    sandboxMode: "read-only",
    networkMode: "none",
    outputSchemaName: "sender-turn.schema.json",
    correlationId: "correlation-1",
    maxTurns: 2,
  };
}

describe("ConnectorTurnExecutor", () => {
  it("gives the cloud lease enough time for research, drafting, and delivery", () => {
    expect(connectorJobTimeoutMs(300_000)).toBe(420_000);
    expect(() => connectorJobTimeoutMs(999)).toThrow("timeout is invalid");
  });

  it("dispatches a path-free job and keeps provider sessions local", async () => {
    const dispatch = vi.fn<ConnectorJobRelay["dispatch"]>(async () => ({
      provider: "codex",
      final: { state: "ready" },
      changedFiles: [],
      exitCode: 0,
      durationMs: 5,
    }));
    const executor = new ConnectorTurnExecutor(
      { dispatch, cancel: vi.fn(async () => false) },
      { createJobId: () => "job-1" },
    );

    await expect(executor.run(scope, request())).resolves.toMatchObject({
      provider: "codex",
      final: { state: "ready" },
    });
    expect(dispatch).toHaveBeenCalledWith(
      {
        jobId: "job-1",
        connectorBindingId: "connector-binding-1",
        userId: "user-1",
        githubRepositoryId: "1345851083",
        conversationId: "conversation-1",
        provider: "codex",
        purpose: "sender_draft",
        runtimePrompt: "Prepare a bounded draft.",
        persistedSummary: "Approved shared context only.",
        sessionMode: "continue",
        sandboxMode: "read-only",
        networkMode: "none",
        outputSchemaName: "sender-turn.schema.json",
        correlationId: "correlation-1",
        maxTurns: 2,
      },
      undefined,
    );
    const serialized = JSON.stringify(dispatch.mock.calls[0]?.[0]);
    expect(serialized).not.toMatch(/workspace|path|sessionId|credential/i);
  });

  it("carries the authorized execution policy so the connector can enforce it", async () => {
    const dispatch = vi.fn<ConnectorJobRelay["dispatch"]>(async () => ({
      provider: "codex",
      final: {},
      changedFiles: [],
      exitCode: 0,
      durationMs: 1,
    }));
    const executor = new ConnectorTurnExecutor({
      dispatch,
      cancel: vi.fn(async () => false),
    });

    await executor.run(scope, {
      ...request(),
      sandboxMode: "workspace-write",
      networkMode: "default",
    });

    // The cloud decides sandbox/network policy; a job that omitted it would let
    // the local connector silently choose its own.
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      sandboxMode: "workspace-write",
      networkMode: "default",
    });
  });

  it("rejects an untyped cloud request that carries a local path", async () => {
    const relay: ConnectorJobRelay = {
      dispatch: vi.fn(),
      cancel: vi.fn(async () => false),
    };
    const executor = new ConnectorTurnExecutor(relay);
    await expect(
      executor.run(scope, {
        ...request(),
        workspacePath: "C:\\private\\repo",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_RUNTIME_POLICY" });
    expect(relay.dispatch).not.toHaveBeenCalled();
  });
});
