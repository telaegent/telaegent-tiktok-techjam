import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RunCancelledError } from "../errors.js";
import {
  InMemoryProviderSessionStore,
  ProviderSessionManager,
} from "../provider-session-manager.js";
import type {
  MiddlewareRunRequest,
  NormalizedRunResult,
  RuntimeProgressEvent,
} from "../runtime-contract.js";
import {
  ConnectorCredentialRejectedError,
  ConnectorTransportUnavailableError,
  ConnectorWorker,
  HttpConnectorWorkerTransport,
  retryDelayMs,
  type ConnectorWorkerTransport,
} from "./connector-worker.js";
import { RuntimeProviderError } from "../runtime-errors.js";
import type { ResourceExchangeResponse } from "./resource-exchange.js";
import type { ConnectorJobRequest, ConnectorJobResult } from "./connector-turn-executor.js";
import type { ConnectorDelivery } from "./long-poll-job-relay.js";
import type { ResourceRegistry } from "./resource-registry.js";

const binding = {
  connectorBindingId: "50000000-0000-4000-8000-000000000005",
  authenticatedUserId: "10000000-0000-4000-8000-000000000001",
  githubRepositoryId: "9223372036854775807",
  workspacePath: ".",
};
const job: ConnectorJobRequest = {
  jobId: "60000000-0000-4000-8000-000000000006",
  connectorBindingId: binding.connectorBindingId,
  userId: binding.authenticatedUserId,
  githubRepositoryId: binding.githubRepositoryId,
  conversationId: "70000000-0000-4000-8000-000000000007",
  provider: "claude",
  purpose: "sender_draft",
  runtimePrompt: "Prepare a private draft",
  persistedSummary: "Approved history",
  sessionMode: "ephemeral",
  sandboxMode: "read-only",
  networkMode: "none",
  outputSchemaName: "sender-turn.schema.json",
  correlationId: "draft-1",
  maxTurns: 2,
};

class FakeTransport implements ConnectorWorkerTransport {
  readonly progressEvents: RuntimeProgressEvent[] = [];
  readonly results: ConnectorJobResult[] = [];
  readonly failures: string[] = [];
  readonly resourceResponses: ResourceExchangeResponse[] = [];
  readonly pollTimes: number[] = [];
  private deliveries: Array<ConnectorDelivery | Error>;

  constructor(...deliveries: Array<ConnectorDelivery | Error>) {
    this.deliveries = [...deliveries];
  }

  async poll(signal?: AbortSignal): Promise<ConnectorDelivery | null> {
    this.pollTimes.push(Date.now());
    const delivery = this.deliveries.shift();
    if (delivery instanceof Error) throw delivery;
    if (delivery) return delivery;
    if (!signal) return null;
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

  async resourceResponse(response: ResourceExchangeResponse): Promise<void> {
    this.resourceResponses.push(response);
  }
}

function sessions(run: (request: MiddlewareRunRequest) => Promise<NormalizedRunResult>) {
  return new ProviderSessionManager(
    { run },
    new InMemoryProviderSessionStore(),
    async (_scope, request) => request,
  );
}

describe("connector-local registry maintenance", () => {
  it("prunes on startup and then at a bounded local-only cadence", async () => {
    let currentTime = 1_000;
    const registry: ResourceRegistry = {
      mint: vi.fn(async () => "resource_aaaaaaaaaaaaaaaaaaaaaaaa"),
      resolve: vi.fn(async () => null),
      removeTask: vi.fn(async () => undefined),
      pruneExpired: vi.fn(async () => 0),
    };
    const worker = new ConnectorWorker(
      binding,
      sessions(async () => {
        throw new Error("runtime must not run while the connector is idle");
      }),
      new FakeTransport(),
      {
        cancel: async () => false,
        resources: { registry },
        resourceCleanupIntervalMs: 100,
        now: () => currentTime,
      },
    );

    await expect(worker.runOnce()).resolves.toBe("idle");
    await expect(worker.runOnce()).resolves.toBe("idle");
    expect(registry.pruneExpired).toHaveBeenCalledTimes(1);

    currentTime = 1_100;
    await expect(worker.runOnce()).resolves.toBe("idle");
    expect(registry.pruneExpired).toHaveBeenCalledTimes(2);
  });
});

/**
 * The ask half of the capability loop (build plan 8.2).
 *
 * A model has one channel back - the JSON object it was told to produce - so
 * its questions arrive inside the answer, while the cloud reads them from the
 * result envelope. These cover the move between the two, on the last machine
 * that is still the asking developer's own.
 */
describe("carrying a turn\u0027s questions off the machine that asked them", () => {
  function answering(final: unknown) {
    const transport = new FakeTransport({
      kind: "job",
      job: { ...job, purpose: "recipient_answer" as const },
    });
    const worker = new ConnectorWorker(
      binding,
      sessions(async () => ({
        provider: "claude" as const,
        final,
        changedFiles: [],
        exitCode: 0,
        durationMs: 10,
      })),
      transport,
      { cancel: async () => false },
    );
    return { transport, worker };
  }

  const answer = (resourceRequests: unknown) => ({
    state: "ready",
    privateSummary: "Answered from what I can see.",
    sendCandidate: "Our rotation window is one hour.",
    riskFlags: [],
    sourcePaths: ["src/auth/session.ts"],
    resourceRequests,
  });

  it("posts the questions beside the answer, and leaves the answer alone", async () => {
    const final = answer([
      { kind: "hint", hint: "the auth session module", reason: "to compare windows" },
    ]);
    const { transport, worker } = answering(final);

    await expect(worker.runOnce()).resolves.toBe("completed");

    expect(transport.results[0]?.resourceRequests).toEqual([
      { kind: "hint", hint: "the auth session module", reason: "to compare windows" },
    ]);
    // The answer is passed on exactly as written. The cloud parses it against
    // the protocol schema, and editing it here would be a claim about
    // somebody's turn that a transport step is not entitled to make.
    expect(transport.results[0]?.final).toEqual(final);
  });

  it("says nothing about resources when a turn asked for none", async () => {
    const { transport, worker } = answering(answer(undefined));

    await expect(worker.runOnce()).resolves.toBe("completed");

    expect(transport.results[0]).not.toHaveProperty("resourceRequests");
  });

  it("drops a request it cannot recognise without losing the turn", async () => {
    // A path is the shape a model reaches for and the one form that must never
    // travel. Dropping it silently keeps the answer - which the owner is
    // waiting on - rather than failing a turn over a malformed question.
    const { transport, worker } = answering(
      answer([
        { kind: "path", path: "src/auth/session.ts", reason: "to read it" },
        { kind: "hint", hint: "the auth session module", reason: "to compare windows" },
      ]),
    );

    await expect(worker.runOnce()).resolves.toBe("completed");

    expect(transport.results[0]?.resourceRequests).toEqual([
      { kind: "hint", hint: "the auth session module", reason: "to compare windows" },
    ]);
    expect(transport.failures).toEqual([]);
  });

  it("trims a turn that asks for more than transport will carry", async () => {
    // The result route caps the batch. Trimming here means an over-curious
    // turn loses its excess questions rather than its whole answer.
    const { transport, worker } = answering(
      answer(
        Array.from({ length: 20 }, (_, index) => ({
          kind: "hint",
          hint: "file " + String(index),
          reason: "why",
        })),
      ),
    );

    await expect(worker.runOnce()).resolves.toBe("completed");

    expect(transport.results[0]?.resourceRequests).toHaveLength(16);
  });

  it("ignores a non-object answer rather than trusting its shape", async () => {
    const { transport, worker } = answering("not an object");

    await expect(worker.runOnce()).resolves.toBe("completed");

    expect(transport.results[0]).not.toHaveProperty("resourceRequests");
  });
});

describe("ConnectorWorker", () => {
  it("resolves the workspace only from its local binding", async () => {
    const run = vi.fn(async (request: MiddlewareRunRequest) => {
      expect(request.workspacePath).toBe(path.resolve("."));
      expect(request.connectorBindingId).toBe(binding.connectorBindingId);
      return {
        provider: "claude" as const,
        final: { sendCandidate: "Ready" },
        changedFiles: [],
        exitCode: 0,
        durationMs: 10,
      };
    });
    const transport = new FakeTransport({ kind: "job", job });
    const worker = new ConnectorWorker(binding, sessions(run), transport, {
      cancel: async () => false,
    });

    await expect(worker.runOnce()).resolves.toBe("completed");
    // Investigation and draft. The per-request assertions above therefore run
    // on both passes: neither may take its workspace from the job.
    expect(run).toHaveBeenCalledTimes(2);
    expect(transport.results).toHaveLength(1);
  });

  it("rejects a cross-repository job before provider execution", async () => {
    const run = vi.fn();
    const transport = new FakeTransport({
      kind: "job",
      job: { ...job, githubRepositoryId: "123456789" },
    });
    const worker = new ConnectorWorker(binding, sessions(run), transport, {
      cancel: async () => false,
    });
    await expect(worker.runOnce()).rejects.toThrow(
      "Connector job does not match the local repository binding",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects cloud attempts to broaden the fixed read-only policy", async () => {
    const run = vi.fn();
    const transport = new FakeTransport({
      kind: "job",
      job: { ...job, networkMode: "default" } as unknown as ConnectorJobRequest,
    });
    const worker = new ConnectorWorker(binding, sessions(run), transport, {
      cancel: async () => false,
    });
    await expect(worker.runOnce()).rejects.toBeDefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("normalizes local provider failures before reporting them", async () => {
    const transport = new FakeTransport({ kind: "job", job });
    const onRuntimeFailure = vi.fn();
    const worker = new ConnectorWorker(
      binding,
      sessions(async () => {
        throw new Error("401 token=private-provider-value");
      }),
      transport,
      { cancel: async () => false, onRuntimeFailure },
    );
    await expect(worker.runOnce()).resolves.toBe("completed");
    expect(transport.failures).toEqual(["RUNTIME_FAILED"]);
    expect(onRuntimeFailure).toHaveBeenCalledWith({
      provider: "claude",
      code: "RUNTIME_FAILED",
      errorName: "Error",
      phase: "unknown",
      exitCode: null,
    });
    expect(JSON.stringify(onRuntimeFailure.mock.calls)).not.toContain(
      "private-provider-value",
    );
  });

  it("does not let diagnostic output prevent the durable failure update", async () => {
    const transport = new FakeTransport({ kind: "job", job });
    const worker = new ConnectorWorker(
      binding,
      sessions(async () => {
        throw new Error("private provider detail");
      }),
      transport,
      {
        cancel: async () => false,
        onRuntimeFailure: () => {
          throw new Error("broken stderr sink");
        },
      },
    );

    await expect(worker.runOnce()).resolves.toBe("completed");
    expect(transport.failures).toEqual(["RUNTIME_FAILED"]);
  });

  it("reports provider exit metadata locally but sends only the safe code", async () => {
    const transport = new FakeTransport({ kind: "job", job });
    const onRuntimeFailure = vi.fn();
    const worker = new ConnectorWorker(
      binding,
      sessions(async () => {
        throw new RuntimeProviderError(
          "RUNTIME_FAILED",
          "private provider output",
          { phase: "provider_exit", exitCode: 1 },
        );
      }),
      transport,
      { cancel: async () => false, onRuntimeFailure },
    );

    await expect(worker.runOnce()).resolves.toBe("completed");
    expect(onRuntimeFailure).toHaveBeenCalledWith({
      provider: "claude",
      code: "RUNTIME_FAILED",
      errorName: "RuntimeProviderError",
      phase: "provider_exit",
      exitCode: 1,
    });
    expect(JSON.stringify(onRuntimeFailure.mock.calls)).not.toContain(
      "private provider output",
    );
    expect(transport.failures).toEqual(["RUNTIME_FAILED"]);
  });

  it("keeps raw provider text local while forwarding structural progress", async () => {
    const transport = new FakeTransport({ kind: "job", job });
    const runtime = new ProviderSessionManager(
      {
        run: async (_request, onProgress) => {
          onProgress?.({ type: "turn_started", provider: "claude" });
          onProgress?.({
            type: "text_delta",
            provider: "claude",
            text: "private raw provider stream C:\\Users\\owner\\repo",
          });
          onProgress?.({ type: "turn_completed", provider: "claude" });
          return {
            provider: "claude" as const,
            final: { sendCandidate: "Bounded candidate" },
            changedFiles: [],
            exitCode: 0,
            durationMs: 10,
          };
        },
      },
      new InMemoryProviderSessionStore(),
      async (_scope, request) => request,
    );
    const worker = new ConnectorWorker(binding, runtime, transport, {
      cancel: async () => false,
    });

    await expect(worker.runOnce()).resolves.toBe("completed");
    // Both passes of the private turn stream structural progress. The raw
    // provider text crosses from neither.
    expect(transport.progressEvents).toEqual([
      { type: "turn_started", provider: "claude" },
      { type: "turn_completed", provider: "claude" },
      { type: "turn_started", provider: "claude" },
      { type: "turn_completed", provider: "claude" },
    ]);
    expect(JSON.stringify(transport.progressEvents)).not.toContain("owner");
  });

  it("cancels the owned local process when cloud cancellation arrives", async () => {
    let rejectRun!: (error: unknown) => void;
    const runtime = sessions(
      async () => await new Promise<NormalizedRunResult>((_resolve, reject) => {
        rejectRun = reject;
      }),
    );
    const transport = new FakeTransport(
      { kind: "job", job },
      { kind: "cancel", jobId: job.jobId },
    );
    const cancel = vi.fn(async () => {
      rejectRun(new RunCancelledError());
      return true;
    });
    const worker = new ConnectorWorker(binding, runtime, transport, { cancel });
    await expect(worker.runOnce()).resolves.toBe("cancelled");
    expect(cancel).toHaveBeenCalledWith(binding.connectorBindingId);
    expect(transport.results).toHaveLength(0);
    expect(transport.failures).toHaveLength(0);
  });

  it("keeps the turn outcome when joining the cancellation watcher fails", async () => {
    // Cleanup is not a verdict. The watcher is deliberately aborted as this
    // turn winds down, so its rejection used to escape the finally block and
    // replace an already settled outcome -- surfacing to the caller as an
    // AbortError attributed to the provider, which is how a healthy CLI came
    // to be reported as unavailable in production.
    let rejectRun!: (error: unknown) => void;
    const runtime = sessions(
      async () => await new Promise<NormalizedRunResult>((_resolve, reject) => {
        rejectRun = reject;
      }),
    );
    const transport = new FakeTransport(
      { kind: "job", job },
      { kind: "cancel", jobId: job.jobId },
    );
    const cancel = vi.fn(async () => {
      rejectRun(new RunCancelledError());
      throw new DOMException("This operation was aborted", "AbortError");
    });
    const worker = new ConnectorWorker(binding, runtime, transport, { cancel });

    await expect(worker.runOnce()).resolves.toBe("cancelled");
    expect(transport.results).toHaveLength(0);
    expect(transport.failures).toHaveLength(0);
  });

  it("serves resource requests while watching an active provider turn", async () => {
    let rejectRun!: (error: unknown) => void;
    const runtime = sessions(
      async () => await new Promise<NormalizedRunResult>((_resolve, reject) => {
        rejectRun = reject;
      }),
    );
    const transport = new FakeTransport(
      { kind: "job", job },
      {
        kind: "resource_request",
        request: {
          requestId: "resource-during-turn",
          taskId: "task-1",
          connectorBindingId: binding.connectorBindingId,
          peerUserId: "10000000-0000-4000-8000-000000000002",
          requests: [{
            kind: "resource",
            resourceId: `resource_${"a".repeat(24)}`,
            reason: "Needed for the approved task",
          }],
          grants: [],
        },
      },
      { kind: "cancel", jobId: job.jobId },
    );
    const cancel = vi.fn(async () => {
      rejectRun(new RunCancelledError());
      return true;
    });
    const worker = new ConnectorWorker(binding, runtime, transport, { cancel });

    await expect(worker.runOnce()).resolves.toBe("cancelled");
    expect(transport.resourceResponses).toEqual([{
      requestId: "resource-during-turn",
      outcomes: [{ status: "refused" }],
    }]);
    expect(cancel).toHaveBeenCalledWith(binding.connectorBindingId);
    expect(transport.results).toHaveLength(0);
    expect(transport.failures).toHaveLength(0);
  });

  it("aborts and joins an active provider turn when its caller stops", async () => {
    let receivedSignal: AbortSignal | undefined;
    let markRuntimeStarted!: () => void;
    const runtimeStarted = new Promise<void>((resolve) => {
      markRuntimeStarted = resolve;
    });
    const runtime = new ProviderSessionManager(
      {
        run: async (
          _request: MiddlewareRunRequest,
          _onProgress: unknown,
          signal?: AbortSignal,
        ): Promise<NormalizedRunResult> => {
          receivedSignal = signal;
          markRuntimeStarted();
          return await new Promise<NormalizedRunResult>((_resolve, reject) => {
            if (signal?.aborted) return reject(new RunCancelledError());
            signal?.addEventListener("abort", () => reject(new RunCancelledError()), {
              once: true,
            });
          });
        },
      },
      new InMemoryProviderSessionStore(),
      async (_scope, request) => request,
    );
    const transport = new FakeTransport({ kind: "job", job });
    const worker = new ConnectorWorker(binding, runtime, transport, {
      cancel: async () => false,
    });
    const controller = new AbortController();

    const running = worker.runOnce(controller.signal);
    await runtimeStarted;
    controller.abort();

    await expect(running).resolves.toBe("cancelled");
    expect(receivedSignal?.aborted).toBe(true);
    expect(transport.results).toHaveLength(0);
    expect(transport.failures).toHaveLength(0);
  });

  it.each(["claude", "codex"] as const)(
    "cancels an active %s process and stops after credential revocation",
    async (provider) => {
      let rejectRun!: (error: unknown) => void;
      const runtime = sessions(
        async () => await new Promise<NormalizedRunResult>((_resolve, reject) => {
          rejectRun = reject;
        }),
      );
      const transport = new FakeTransport(
        { kind: "job", job: { ...job, provider } },
        new ConnectorCredentialRejectedError(),
      );
      const cancel = vi.fn(async () => {
        rejectRun(new RunCancelledError());
        return true;
      });
      const worker = new ConnectorWorker(binding, runtime, transport, { cancel });

      await expect(worker.runOnce()).rejects.toThrow("Connector credential was rejected");
      expect(cancel).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledWith(binding.connectorBindingId);
      expect(transport.pollTimes).toHaveLength(2);
      expect(transport.results).toHaveLength(0);
      expect(transport.failures).toHaveLength(0);
    },
  );

  it("aborts pre-launch execution even when no provider process is active yet", async () => {
    let receivedSignal: AbortSignal | undefined;
    const run = vi.fn(
      async (
        _request: MiddlewareRunRequest,
        _onProgress: unknown,
        signal?: AbortSignal,
      ): Promise<NormalizedRunResult> => {
        receivedSignal = signal;
        return await new Promise<NormalizedRunResult>((_resolve, reject) => {
          if (signal?.aborted) return reject(new RunCancelledError());
          signal?.addEventListener(
            "abort",
            () => reject(new RunCancelledError()),
            { once: true },
          );
        });
      },
    );
    const transport = new FakeTransport(
      { kind: "job", job: { ...job, provider: "codex" } },
      new ConnectorCredentialRejectedError(),
    );
    const worker = new ConnectorWorker(
      binding,
      new ProviderSessionManager(
        { run },
        new InMemoryProviderSessionStore(),
        async (_scope, request) => request,
      ),
      transport,
      { cancel: async () => false },
    );

    await expect(worker.runOnce()).rejects.toBeInstanceOf(
      ConnectorCredentialRejectedError,
    );
    expect(receivedSignal?.aborted).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("backs off transient cancellation-poll failures", async () => {
    vi.useFakeTimers();
    try {
      let rejectRun!: (error: unknown) => void;
      const runtime = sessions(
        async () => await new Promise<NormalizedRunResult>((_resolve, reject) => {
          rejectRun = reject;
        }),
      );
      const transport = new FakeTransport(
        { kind: "job", job },
        new Error("temporary network failure"),
        { kind: "cancel", jobId: job.jobId },
      );
      const cancel = vi.fn(async () => {
        rejectRun(new RunCancelledError());
        return true;
      });
      const worker = new ConnectorWorker(binding, runtime, transport, {
        cancel,
        pollRetryDelayMs: 1_000,
      });

      const run = worker.runOnce();
      await vi.advanceTimersByTimeAsync(999);
      expect(transport.pollTimes).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(run).resolves.toBe("cancelled");
      expect(transport.pollTimes).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HttpConnectorWorkerTransport", () => {
  it.each([401, 403])("classifies HTTP %s as terminal credential rejection", async (status) => {
    const fetchImplementation = vi.fn(async () => new Response(null, { status }));
    const transport = new HttpConnectorWorkerTransport(
      "https://telaegent.example/",
      binding.connectorBindingId,
      "a".repeat(40),
      fetchImplementation,
    );

    await expect(transport.poll()).rejects.toBeInstanceOf(ConnectorCredentialRejectedError);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("reconnects transient requests with capped exponential backoff", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const delays: number[] = [];
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    const transport = new HttpConnectorWorkerTransport(
      "https://telaegent.example/",
      binding.connectorBindingId,
      "a".repeat(40),
      fetchImplementation,
      {
        initialDelayMs: 100,
        maximumDelayMs: 150,
        jitterRatio: 0,
        sleep: async (delayMs) => { delays.push(delayMs); },
        onRetry: (event) => { retries.push({ ...event }); },
      },
    );

    await expect(transport.poll()).resolves.toBeNull();
    expect(delays).toEqual([100, 150]);
    expect(retries).toEqual([
      { attempt: 1, delayMs: 100 },
      { attempt: 2, delayMs: 150 },
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("bounds retry jitter even if the injected random source is invalid", () => {
    expect(retryDelayMs(3, 100, 250, 0.2, () => -10)).toBe(200);
    expect(retryDelayMs(3, 100, 250, 0.2, () => 10)).toBe(250);
  });

  it("drops advisory progress after bounded reconnect attempts", async () => {
    const fetchImplementation = vi.fn(async () => new Response(null, { status: 503 }));
    const delays: number[] = [];
    const transport = new HttpConnectorWorkerTransport(
      "https://telaegent.example/",
      binding.connectorBindingId,
      "a".repeat(40),
      fetchImplementation,
      {
        initialDelayMs: 10,
        maximumDelayMs: 20,
        jitterRatio: 0,
        sleep: async (delayMs) => { delays.push(delayMs); },
      },
    );

    await expect(transport.progress(job.jobId, {
      type: "turn_started",
      provider: "claude",
    })).rejects.toBeInstanceOf(ConnectorTransportUnavailableError);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([10, 20]);
  });
});
