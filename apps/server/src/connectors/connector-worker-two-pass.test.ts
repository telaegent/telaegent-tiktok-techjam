import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemoryProviderSessionStore,
  ProviderSessionManager,
} from "../provider-session-manager.js";
import type {
  MiddlewareRunRequest,
  NormalizedRunResult,
  RuntimeProgressEvent,
  RuntimeProgressSink,
} from "../runtime-contract.js";
import { ConnectorWorker, type ConnectorWorkerTransport } from "./connector-worker.js";
import type { ConnectorJobRequest, ConnectorJobResult } from "./connector-turn-executor.js";
import type { ConnectorDelivery } from "./long-poll-job-relay.js";
import type { ResourceExchangeResponse } from "./resource-exchange.js";

const workspacePath = path.resolve("/repo");

const binding = {
  connectorBindingId: "50000000-0000-4000-8000-000000000005",
  authenticatedUserId: "10000000-0000-4000-8000-000000000001",
  githubRepositoryId: "9223372036854775807",
  workspacePath,
};

const job: ConnectorJobRequest = {
  jobId: "60000000-0000-4000-8000-000000000006",
  connectorBindingId: binding.connectorBindingId,
  userId: binding.authenticatedUserId,
  githubRepositoryId: binding.githubRepositoryId,
  conversationId: "70000000-0000-4000-8000-000000000007",
  provider: "claude",
  purpose: "recipient_answer",
  runtimePrompt: "How does session refresh work?",
  persistedSummary: "Approved history",
  sessionMode: "continue",
  sandboxMode: "read-only",
  networkMode: "none",
  outputSchemaName: "recipient-turn.schema.json",
  correlationId: "answer-1",
  maxTurns: 2,
};

const draftFinal = {
  state: "ready",
  assistantMessage: "ok",
  sendCandidate: "ok",
  riskFlags: [],
  referencedPaths: [],
};

class FakeTransport implements ConnectorWorkerTransport {
  readonly progressEvents: RuntimeProgressEvent[] = [];
  readonly results: ConnectorJobResult[] = [];
  readonly failures: string[] = [];
  private deliveries: ConnectorDelivery[] = [{ kind: "job", job }];

  async poll(signal?: AbortSignal): Promise<ConnectorDelivery | null> {
    const delivery = this.deliveries.shift();
    if (delivery) return delivery;
    if (!signal) return null;
    // Park until the worker aborts the watcher, exactly as the production long
    // poll does. Returning null in a loop would busy-spin the cancellation
    // watcher for the whole test.
    return await new Promise((resolve) => {
      if (signal.aborted) return resolve(null);
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
  }

  async progress(_jobId: string, event: RuntimeProgressEvent): Promise<void> {
    this.progressEvents.push(event);
  }

  async result(_jobId: string, result: ConnectorJobResult): Promise<void> {
    this.results.push(result);
  }

  async failure(_jobId: string, code: string): Promise<void> {
    this.failures.push(code);
  }

  async resourceResponse(_response: ResourceExchangeResponse): Promise<void> {}
}

function sessions(
  run: (
    request: MiddlewareRunRequest,
    onProgress?: RuntimeProgressSink,
  ) => Promise<NormalizedRunResult>,
) {
  return new ProviderSessionManager(
    { run },
    new InMemoryProviderSessionStore(),
    async (_scope, request) => request,
  );
}

function ok(final: unknown): NormalizedRunResult {
  return { provider: "claude", final, changedFiles: [], exitCode: 0, durationMs: 1 };
}

describe("activity target containment", () => {
  it("forwards an in-workspace target as a relative label and drops an escape", async () => {
    const transport = new FakeTransport();
    const worker = new ConnectorWorker(
      binding,
      sessions(async (request, onProgress) => {
        // Emit only from the drafting pass. Task 7 adds an investigation pass
        // ahead of it through this same fake runtime, and this guard is what
        // keeps the exact event assertion below true once it does.
        if (request.outputSchemaName !== "recipient-turn.schema.json") {
          return ok(draftFinal);
        }
        onProgress?.({
          type: "activity_started",
          provider: "claude",
          activity: "tool",
          target: path.join(workspacePath, "src", "auth", "session.ts"),
        });
        onProgress?.({
          type: "activity_started",
          provider: "claude",
          activity: "tool",
          target: path.resolve("/home/dev/.aws/credentials"),
        });
        onProgress?.({
          type: "activity_started",
          provider: "claude",
          activity: "tool",
          target: path.join(workspacePath, "..", "other", "a.ts"),
        });
        onProgress?.({ type: "text_delta", provider: "claude", text: "sk-live-1234" });
        onProgress?.({ type: "turn_completed", provider: "claude" });
        return ok(draftFinal);
      }),
      transport,
      { cancel: async () => true },
    );

    await worker.runOnce();

    const activity = transport.progressEvents.filter(
      (event) => event.type === "activity_started",
    );
    expect(activity).toEqual([
      {
        type: "activity_started",
        provider: "claude",
        activity: "tool",
        target: "src/auth/session.ts",
      },
      { type: "activity_started", provider: "claude", activity: "tool" },
      { type: "activity_started", provider: "claude", activity: "tool" },
    ]);
    expect(JSON.stringify(transport.progressEvents)).not.toContain("sk-live-1234");
    expect(JSON.stringify(transport.progressEvents)).not.toContain(".aws");
    expect(transport.progressEvents.some((event) => event.type === "turn_completed")).toBe(
      true,
    );
  });
});
