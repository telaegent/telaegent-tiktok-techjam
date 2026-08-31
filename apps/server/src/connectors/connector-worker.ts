import path from "node:path";
import { z } from "zod";
import type {
  ManagedAgentTurnRequest,
  ProviderSessionManager,
  ProviderSessionScope,
} from "../provider-session-manager.js";
import type { RuntimeProgressEvent } from "../runtime-contract.js";
import { normalizeRuntimeFailure } from "../runtime-errors.js";
import type {
  ConnectorJobRequest,
  ConnectorJobResult,
} from "./connector-turn-executor.js";
import type { ConnectorDelivery } from "./long-poll-job-relay.js";

const idPart = z.string().min(1).max(256).regex(/^[^\u0000\r\n]+$/);
const jobSchema = z.strictObject({
  jobId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  connectorBindingId: z.string().uuid(),
  userId: z.string().uuid(),
  githubRepositoryId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  conversationId: idPart,
  provider: z.enum(["codex", "claude"]),
  purpose: z.enum(["sender_draft", "recipient_answer"]),
  runtimePrompt: z.string().min(1).max(1_048_576).refine((value) => !value.includes("\0")),
  persistedSummary: z.string().max(524_288).refine((value) => !value.includes("\0")),
  sessionMode: z.enum(["continue", "fresh", "ephemeral"]),
  sandboxMode: z.literal("read-only"),
  networkMode: z.literal("none"),
  outputSchemaName: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\.schema\.json$/),
  correlationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  maxTurns: z.number().int().min(1).max(3),
});
const deliverySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("job"), job: jobSchema }),
  z.strictObject({
    kind: z.literal("cancel"),
    jobId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  }),
]);

export interface LocalConnectorBinding {
  connectorBindingId: string;
  authenticatedUserId: string;
  githubRepositoryId: string;
  /** Local-only canonical path. This value is never sent to the cloud. */
  workspacePath: string;
}

export interface ConnectorWorkerTransport {
  poll(signal?: AbortSignal): Promise<ConnectorDelivery | null>;
  progress(jobId: string, event: RuntimeProgressEvent): Promise<void>;
  result(jobId: string, result: ConnectorJobResult): Promise<void>;
  failure(jobId: string, code: string): Promise<void>;
}

export interface ConnectorWorkerOptions {
  cancel: (connectorBindingId: string) => Promise<boolean>;
}

/** Connector-side reference monitor for one user x repository binding. */
export class ConnectorWorker {
  private readonly binding: LocalConnectorBinding;

  constructor(
    binding: Readonly<LocalConnectorBinding>,
    private readonly sessions: ProviderSessionManager,
    private readonly transport: ConnectorWorkerTransport,
    private readonly options: ConnectorWorkerOptions,
  ) {
    this.binding = { ...binding, workspacePath: path.resolve(binding.workspacePath) };
  }

  async runOnce(): Promise<"idle" | "completed" | "cancelled"> {
    const untrustedDelivery = await this.transport.poll();
    if (untrustedDelivery === null) return "idle";
    const delivery = deliverySchema.parse(untrustedDelivery);
    if (delivery.kind === "cancel") return "idle";
    const job = delivery.job;
    this.assertOwnedJob(job);

    const cancellationController = new AbortController();
    let cancelled = false;
    const execution = this.sessions.run(
      this.scope(job),
      this.request(job),
      (event) => void this.transport.progress(job.jobId, event).catch(() => undefined),
    );
    // ProviderSessionManager enters through a serialized queue. Let the owned
    // run acquire that queue before a synthetic/very-fast cancellation can be
    // observed by the concurrent long poll.
    await Promise.resolve();
    const cancellation = this.watchCancellation(
      job.jobId,
      cancellationController.signal,
      () => {
        cancelled = true;
      },
    );
    try {
      const result = await execution;
      if (cancelled) return "cancelled";
      await this.transport.result(job.jobId, result);
      return "completed";
    } catch (error) {
      const failure = normalizeRuntimeFailure(error);
      if (failure.code === "RUNTIME_CANCELLED" || cancelled) return "cancelled";
      await this.transport.failure(job.jobId, failure.code);
      return "completed";
    } finally {
      cancellationController.abort();
      await cancellation;
    }
  }

  private async watchCancellation(
    jobId: string,
    signal: AbortSignal,
    onCancelled: () => void,
  ): Promise<void> {
    while (!signal.aborted) {
      let delivery: ConnectorDelivery | null;
      try {
        const untrustedDelivery = await this.transport.poll(signal);
        delivery = untrustedDelivery === null
          ? null
          : deliverySchema.parse(untrustedDelivery);
      } catch {
        if (signal.aborted) return;
        continue;
      }
      if (delivery?.kind !== "cancel" || delivery.jobId !== jobId) continue;
      onCancelled();
      await this.options.cancel(this.binding.connectorBindingId);
      return;
    }
  }

  private assertOwnedJob(job: Readonly<ConnectorJobRequest>): void {
    if (
      job.connectorBindingId !== this.binding.connectorBindingId ||
      job.userId !== this.binding.authenticatedUserId ||
      job.githubRepositoryId !== this.binding.githubRepositoryId
    ) {
      throw new Error("Connector job does not match the local repository binding");
    }
  }

  private scope(job: Readonly<ConnectorJobRequest>): ProviderSessionScope {
    return {
      userId: this.binding.authenticatedUserId,
      githubRepositoryId: this.binding.githubRepositoryId,
      conversationId: job.conversationId,
      provider: job.provider,
    };
  }

  private request(job: Readonly<ConnectorJobRequest>): ManagedAgentTurnRequest {
    return {
      agentId: this.binding.connectorBindingId,
      connectorBindingId: this.binding.connectorBindingId,
      workspacePath: this.binding.workspacePath,
      purpose: job.purpose,
      runtimePrompt: job.runtimePrompt,
      persistedSummary: job.persistedSummary,
      sessionMode: job.sessionMode,
      sandboxMode: job.sandboxMode,
      networkMode: job.networkMode,
      outputSchemaName: job.outputSchemaName,
      correlationId: job.correlationId,
      maxTurns: job.maxTurns,
    };
  }
}

export class HttpConnectorWorkerTransport implements ConnectorWorkerTransport {
  private readonly jobsUrl: string;

  constructor(
    serverOrigin: string,
    connectorBindingId: string,
    private readonly credential: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    const origin = new URL(serverOrigin);
    const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(origin.hostname);
    if (
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      throw new Error("Connector server origin is invalid");
    }
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(credential)) {
      throw new Error("Connector credential is invalid");
    }
    this.jobsUrl = `${origin.origin}/api/connectors/jobs`;
    this.connectorBindingId = z.string().uuid().parse(connectorBindingId);
  }

  private readonly connectorBindingId: string;

  async poll(signal?: AbortSignal): Promise<ConnectorDelivery | null> {
    const query = new URLSearchParams({
      connectorBindingId: this.connectorBindingId,
      waitMs: "20000",
    });
    const response = await this.request(`/next?${query}`, {
      method: "GET",
      ...(signal ? { signal } : {}),
    });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error("Connector job poll failed");
    return deliverySchema.parse(await response.json());
  }

  async progress(jobId: string, event: RuntimeProgressEvent): Promise<void> {
    await this.send(jobId, "progress", event);
  }

  async result(jobId: string, result: ConnectorJobResult): Promise<void> {
    await this.send(jobId, "result", result);
  }

  async failure(jobId: string, code: string): Promise<void> {
    await this.send(jobId, "failure", { code });
  }

  private async send(jobId: string, action: string, body: unknown): Promise<void> {
    const safeJobId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).parse(jobId);
    const response = await this.request(`/${encodeURIComponent(safeJobId)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok && response.status !== 409) {
      throw new Error("Connector job update failed");
    }
  }

  private request(pathname: string, init: RequestInit): Promise<Response> {
    return this.fetchImplementation(this.jobsUrl + pathname, {
      ...init,
      headers: {
        authorization: `Bearer ${this.credential}`,
        accept: "application/json",
        ...init.headers,
      },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  }
}
