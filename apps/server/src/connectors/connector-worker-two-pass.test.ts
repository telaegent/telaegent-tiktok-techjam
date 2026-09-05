import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
const SYNTHETIC_PROGRESS_SECRET = ["sk", "live", "1234"].join("-");

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

  /** Set to model a cloud that rejects an event shape it does not know. */
  rejectProgress = false;

  async progress(_jobId: string, event: RuntimeProgressEvent): Promise<void> {
    this.progressEvents.push(event);
    if (this.rejectProgress) throw new Error("400 unrecognized_keys: target");
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
    signal?: AbortSignal,
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
        onProgress?.({
          type: "text_delta",
          provider: "claude",
          text: SYNTHETIC_PROGRESS_SECRET,
        });
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
    expect(JSON.stringify(transport.progressEvents)).not.toContain(
      SYNTHETIC_PROGRESS_SECRET,
    );
    expect(JSON.stringify(transport.progressEvents)).not.toContain(".aws");
    expect(transport.progressEvents.some((event) => event.type === "turn_completed")).toBe(
      true,
    );
  });
});

describe("two-pass private turn", () => {
  function twoPassWorker(
    run: (request: MiddlewareRunRequest) => Promise<NormalizedRunResult>,
  ): { worker: ConnectorWorker; transport: FakeTransport; requests: MiddlewareRunRequest[] } {
    const transport = new FakeTransport();
    const requests: MiddlewareRunRequest[] = [];
    const worker = new ConnectorWorker(
      binding,
      sessions(async (request) => {
        requests.push(request);
        return await run(request);
      }),
      transport,
      { cancel: async () => true },
    );
    return { worker, transport, requests };
  }

  const byPass = async (request: MiddlewareRunRequest) =>
    request.outputSchemaName === "investigation-note.schema.json"
      ? ok({ note: "Refresh lives in src/auth/session.ts" })
      : ok(draftFinal);

  it("runs investigation first, then the draft, in one job", async () => {
    const { worker, requests } = twoPassWorker(byPass);
    await worker.runOnce();

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      outputSchemaName: "investigation-note.schema.json",
      sessionMode: "ephemeral",
      sandboxMode: "read-only",
      networkMode: "none",
      purpose: "recipient_answer",
      maxTurns: 8,
    });
    expect(requests[1]).toMatchObject({
      outputSchemaName: "recipient-turn.schema.json",
      sandboxMode: "read-only",
      networkMode: "none",
      maxTurns: 2,
    });
    // The draft went through the session store; the investigation did not.
    expect(requests[1]?.sessionMode).not.toBe("ephemeral");
  });

  it("gives the research pass tools and the drafting pass none", async () => {
    const { worker, requests } = twoPassWorker(byPass);
    await worker.runOnce();

    // The split is the whole point of two passes: one reads, one writes. A
    // drafting pass that can read will read, and with two turns it then has
    // none left to return structured output.
    expect(requests[0]?.toolMode).not.toBe("none");
    expect(requests[1]?.toolMode).toBe("none");
  });

  it("still drafts, without tools, when the research pass returns no note", async () => {
    // The degradation path. It used to end the turn in RUNTIME_FAILED: an empty
    // note sent a tool-equipped drafting pass off to read the repository itself,
    // and it exhausted its two turns before reaching structured output.
    const { worker, transport, requests } = twoPassWorker(async (request) =>
      request.outputSchemaName === "investigation-note.schema.json"
        ? ok({ note: "" })
        : ok(draftFinal),
    );
    await worker.runOnce();

    expect(requests).toHaveLength(2);
    expect(requests[1]?.toolMode).toBe("none");
    expect(requests[1]?.runtimePrompt).toContain("How does session refresh work?");
    expect(transport.results).toHaveLength(1);
    expect(transport.failures).toEqual([]);
  });

  it("feeds the note into the drafting prompt", async () => {
    const { worker, requests } = twoPassWorker(byPass);
    await worker.runOnce();

    expect(requests[0]?.runtimePrompt).toContain("How does session refresh work?");
    expect(requests[1]?.runtimePrompt).toContain("Refresh lives in src/auth/session.ts");
    expect(requests[1]?.runtimePrompt).toContain("How does session refresh work?");
  });

  it("never lets the note reach the cloud", async () => {
    const secret = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI";
    const { worker, transport } = twoPassWorker(async (request) =>
      request.outputSchemaName === "investigation-note.schema.json"
        ? ok({ note: secret })
        : ok(draftFinal),
    );
    await worker.runOnce();

    expect(transport.results).toHaveLength(1);
    expect(JSON.stringify(transport.results)).not.toContain(secret);
    expect(JSON.stringify(transport.progressEvents)).not.toContain(secret);
  });

  it("still drafts when investigation fails", async () => {
    const { worker, transport, requests } = twoPassWorker(async (request) => {
      if (request.outputSchemaName === "investigation-note.schema.json") {
        throw new Error("provider exploded");
      }
      return ok(draftFinal);
    });

    expect(await worker.runOnce()).toBe("completed");
    expect(transport.failures).toEqual([]);
    expect(transport.results).toHaveLength(1);
    expect(requests[1]?.runtimePrompt).toBe(job.runtimePrompt);
  });

  it("drafts with the original prompt when the note is not a usable string", async () => {
    const { worker, requests } = twoPassWorker(async (request) =>
      request.outputSchemaName === "investigation-note.schema.json"
        ? ok({ note: 42 })
        : ok(draftFinal),
    );
    await worker.runOnce();

    expect(requests[1]?.runtimePrompt).toBe(job.runtimePrompt);
  });
});

describe("deployment compatibility", () => {
  it("completes the turn when the cloud rejects a progress event it cannot parse", async () => {
    // A cloud deployed before `target` existed answers 400 to an activity
    // event carrying one, because `progressSchema` is built from strict
    // objects. Progress is advisory: losing it degrades the live view of the
    // turn and must never cost the owner the turn itself.
    const transport = new FakeTransport();
    transport.rejectProgress = true;
    const worker = new ConnectorWorker(
      binding,
      sessions(async (request, onProgress) => {
        onProgress?.({
          type: "activity_started",
          provider: "claude",
          activity: "tool",
          target: path.join(workspacePath, "src", "auth", "session.ts"),
        });
        return request.outputSchemaName === "investigation-note.schema.json"
          ? ok({ note: "read src/auth/session.ts" })
          : ok(draftFinal);
      }),
      transport,
      { cancel: async () => true },
    );

    expect(await worker.runOnce()).toBe("completed");
    expect(transport.results).toHaveLength(1);
    expect(transport.failures).toEqual([]);
  });
});

describe("job budget", () => {
  /**
   * The cloud's `LongPollConnectorJobRelay` times the whole job out at
   * `max(CLAUDE_TIMEOUT_MS, CODEX_TIMEOUT_MS)`. Two passes now share that one
   * budget, so the research pass must not be able to spend all of it.
   */
  it("abandons a research pass that outruns its deadline and still drafts", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const requests: MiddlewareRunRequest[] = [];
      const worker = new ConnectorWorker(
        binding,
        sessions(async (request, _onProgress, signal) => {
          requests.push(request);
          if (request.outputSchemaName !== "investigation-note.schema.json") {
            return ok(draftFinal);
          }
          // A provider that reads and reads. It ends only when told to.
          return await new Promise<NormalizedRunResult>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          });
        }),
        transport,
        { cancel: async () => true },
      );

      const running = worker.runOnce();
      await vi.advanceTimersByTimeAsync(90_000);

      expect(await running).toBe("completed");
      expect(requests).toHaveLength(2);
      // The drafting pass got the whole prompt and none of the note.
      expect(requests[1]?.outputSchemaName).toBe("recipient-turn.schema.json");
      expect(requests[1]?.runtimePrompt).toBe(job.runtimePrompt);
      expect(transport.results).toHaveLength(1);
      expect(transport.failures).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not draft a turn the owner cancelled mid-investigation", async () => {
    const owner = new AbortController();
    const transport = new FakeTransport();
    const requests: MiddlewareRunRequest[] = [];
    const worker = new ConnectorWorker(
      binding,
      sessions(async (request) => {
        requests.push(request);
        if (request.outputSchemaName === "investigation-note.schema.json") {
          owner.abort();
          throw new Error("provider stopped");
        }
        return ok(draftFinal);
      }),
      transport,
      { cancel: async () => true },
    );

    expect(await worker.runOnce(owner.signal)).toBe("cancelled");
    // A cancelled research pass must not fall through into a draft nobody is
    // waiting for, and must never post a result for an abandoned job.
    expect(requests).toHaveLength(1);
    expect(transport.results).toEqual([]);
    expect(transport.failures).toEqual([]);
  });
});
