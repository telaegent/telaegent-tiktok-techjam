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
  ConnectorWorker,
  HttpConnectorWorkerTransport,
  type ConnectorWorkerTransport,
} from "./connector-worker.js";
import type { ResourceExchangeResponse } from "./resource-exchange.js";
import type { ConnectorJobRequest, ConnectorJobResult } from "./connector-turn-executor.js";
import type { ConnectorDelivery } from "./long-poll-job-relay.js";

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
    expect(run).toHaveBeenCalledOnce();
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
    const worker = new ConnectorWorker(
      binding,
      sessions(async () => {
        throw new Error("401 token=private-provider-value");
      }),
      transport,
      { cancel: async () => false },
    );
    await expect(worker.runOnce()).resolves.toBe("completed");
    expect(transport.failures).toEqual(["RUNTIME_FAILED"]);
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
});
