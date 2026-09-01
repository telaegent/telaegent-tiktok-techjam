import path from "node:path";
import { z } from "zod";
import type {
  ManagedAgentTurnRequest,
  ProviderSessionManager,
  ProviderSessionScope,
} from "../provider-session-manager.js";
import type { RuntimeProgressEvent } from "../runtime-contract.js";
import {
  RuntimeProviderError,
  normalizeRuntimeFailure,
  type LocalRuntimeFailurePhase,
} from "../runtime-errors.js";
import type {
  ConnectorJobRequest,
  ConnectorJobResult,
} from "./connector-turn-executor.js";
import type { ConnectorDelivery } from "./long-poll-job-relay.js";
import { connectorHttpResponseError } from "./connector-http-error.js";
import { LocalFileBroker } from "./file-broker.js";
import type { ResourcePolicyLimits } from "./resource-policy.js";
import {
  connectorResourceRequestSchema,
  type ConnectorResourceRequest,
} from "./resource-request.js";
import type { ResourceRegistry } from "./resource-registry.js";
import {
  fulfilResourceRequests,
  resourceExchangeRequestSchema,
  type ResourceExchangeRequest,
  type ResourceExchangeResponse,
} from "./resource-exchange.js";

/**
 * The bound the connector result route enforces. Applied here too so an
 * over-curious turn is trimmed on the machine that produced it rather than
 * rejected in transport, which would lose the answer along with the questions.
 */
const MAX_LIFTED_RESOURCE_REQUESTS = 16;

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
  z.strictObject({
    kind: z.literal("resource_request"),
    request: resourceExchangeRequestSchema,
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
  resourceResponse(response: ResourceExchangeResponse): Promise<void>;
}

export interface ConnectorWorkerOptions {
  cancel: (connectorBindingId: string) => Promise<boolean>;
  /** Emits only bounded structural diagnostics on the owning machine. */
  onRuntimeFailure?: (failure: Readonly<{
    provider: "codex" | "claude";
    code: string;
    errorName: string;
    phase: LocalRuntimeFailurePhase | "unknown";
    exitCode: number | null;
  }>) => void;
  pollRetryDelayMs?: number;
  /**
   * Capability serving. Absent means this connector cannot resolve any
   * identifier, so it refuses every resource request rather than guessing.
   */
  resources?: {
    registry: ResourceRegistry;
    limits?: ResourcePolicyLimits;
  };
  /** Local-only maintenance cadence; never causes a cloud/database request. */
  resourceCleanupIntervalMs?: number;
  now?: () => number;
}

export interface ConnectorTransportRetryOptions {
  initialDelayMs?: number;
  maximumDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (event: Readonly<{ attempt: number; delayMs: number }>) => void;
}

export class ConnectorCredentialRejectedError extends Error {
  constructor() {
    super("Connector credential was rejected");
    this.name = "ConnectorCredentialRejectedError";
  }
}

export class ConnectorTransportUnavailableError extends Error {
  constructor() {
    super("Telaegent connector transport is temporarily unavailable");
    this.name = "ConnectorTransportUnavailableError";
  }
}

/** Connector-side reference monitor for one user x repository binding. */
export class ConnectorWorker {
  private readonly binding: LocalConnectorBinding;
  private nextResourceCleanupAt = 0;

  constructor(
    binding: Readonly<LocalConnectorBinding>,
    private readonly sessions: ProviderSessionManager,
    private readonly transport: ConnectorWorkerTransport,
    private readonly options: ConnectorWorkerOptions,
  ) {
    this.binding = { ...binding, workspacePath: path.resolve(binding.workspacePath) };
  }

  async runOnce(): Promise<"idle" | "completed" | "cancelled"> {
    await this.pruneExpiredResources();
    const untrustedDelivery = await this.transport.poll();
    if (untrustedDelivery === null) return "idle";
    const delivery = deliverySchema.parse(untrustedDelivery);
    if (delivery.kind === "cancel") return "idle";
    if (delivery.kind === "resource_request") {
      await this.serveResourceRequest(delivery.request);
      return "completed";
    }
    const job = delivery.job;
    this.assertOwnedJob(job);

    const cancellationController = new AbortController();
    const executionController = new AbortController();
    let cancelled = false;
    let credentialRejection: ConnectorCredentialRejectedError | undefined;
    const execution = this.sessions.run(
      this.scope(job),
      this.request(job),
      // Raw provider text is private working state. The cloud receives only
      // structural status; the bounded final result travels through `result`.
      (event) => {
        if (event.type === "text_delta") return;
        void this.transport.progress(job.jobId, event).catch(() => undefined);
      },
      undefined,
      undefined,
      executionController.signal,
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
        executionController.abort();
      },
      (error) => {
        credentialRejection = error;
        executionController.abort();
      },
    );
    const cancellationFailure = cancellation.then(
      () => new Promise<never>(() => undefined),
      (error: unknown) => Promise.reject(error),
    );
    try {
      const result = await Promise.race([execution, cancellationFailure]);
      if (cancelled) return "cancelled";
      const asks = liftResourceRequests(result.final);
      await this.transport.result(job.jobId, {
        ...result,
        ...(asks.length > 0 ? { resourceRequests: asks } : {}),
      });
      return "completed";
    } catch (error) {
      if (credentialRejection) throw credentialRejection;
      if (error instanceof ConnectorCredentialRejectedError) throw error;
      const failure = normalizeRuntimeFailure(error);
      if (failure.code === "RUNTIME_CANCELLED" || cancelled) return "cancelled";
      try {
        this.options.onRuntimeFailure?.({
          provider: job.provider,
          code: failure.code,
          errorName: safeErrorName(error),
          phase:
            error instanceof RuntimeProviderError
              ? error.localDiagnostic?.phase ?? "unknown"
              : "unknown",
          exitCode:
            error instanceof RuntimeProviderError &&
            Number.isInteger(error.localDiagnostic?.exitCode)
              ? error.localDiagnostic!.exitCode!
              : null,
        });
      } catch {
        // Diagnostics must never prevent the durable failure update.
      }
      await this.transport.failure(job.jobId, failure.code);
      return "completed";
    } finally {
      cancellationController.abort();
      await cancellation.catch((error: unknown) => {
        if (!(error instanceof ConnectorCredentialRejectedError)) throw error;
      });
      if (executionController.signal.aborted) {
        // Do not let a pre-launch provider task outlive revocation. The signal
        // prevents process creation and this await lets its local cleanup finish.
        await execution.catch(() => undefined);
      }
    }
  }

  private async pruneExpiredResources(): Promise<void> {
    const registry = this.options.resources?.registry;
    if (!registry) return;
    const now = (this.options.now ?? Date.now)();
    const interval = this.options.resourceCleanupIntervalMs ?? 300_000;
    if (!Number.isInteger(interval) || interval < 1 || interval > 3_600_000) {
      throw new Error("Connector resource cleanup interval is invalid");
    }
    if (now < this.nextResourceCleanupAt) return;
    await registry.pruneExpired(new Date(now));
    this.nextResourceCleanupAt = now + interval;
  }

  /**
   * Serves a peer resource request without launching a provider.
   *
   * Delivering a file is a reference-monitor operation, not an agent turn: no
   * session is created or resumed, and no model sees the request. That keeps
   * the authorization path free of anything a prompt could influence.
   */
  private async serveResourceRequest(request: ResourceExchangeRequest): Promise<void> {
    if (request.connectorBindingId !== this.binding.connectorBindingId) {
      throw new Error("Resource request does not match the local repository binding");
    }
    const registry = this.options.resources?.registry;
    if (!registry) {
      await this.transport.resourceResponse({
        requestId: request.requestId,
        outcomes: request.requests.map(() => ({ status: "refused" as const })),
      });
      return;
    }
    const limits = this.options.resources?.limits;
    const response = await fulfilResourceRequests(request, {
      registry,
      broker: new LocalFileBroker(this.binding.workspacePath),
      workspacePath: this.binding.workspacePath,
      ...(limits ? { limits } : {}),
    });
    await this.transport.resourceResponse(response);
  }

  private async watchCancellation(
    jobId: string,
    signal: AbortSignal,
    onCancelled: () => void,
    onCredentialRejected: (error: ConnectorCredentialRejectedError) => void,
  ): Promise<void> {
    while (!signal.aborted) {
      let delivery: ConnectorDelivery | null;
      try {
        const untrustedDelivery = await this.transport.poll(signal);
        delivery = untrustedDelivery === null
          ? null
          : deliverySchema.parse(untrustedDelivery);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ConnectorCredentialRejectedError) {
          onCredentialRejected(error);
          onCancelled();
          await this.options.cancel(this.binding.connectorBindingId).catch(() => false);
          throw error;
        }
        await waitForRetry(signal, this.options.pollRetryDelayMs ?? 1_000);
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
    private readonly retryOptions: ConnectorTransportRetryOptions = {},
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
    assertCredentialAccepted(response);
    if (!response.ok) throw await connectorHttpResponseError(response, "job poll");
    return deliverySchema.parse(await response.json());
  }

  async progress(jobId: string, event: RuntimeProgressEvent): Promise<void> {
    // Progress is advisory. Bound its reconnect attempts so an outage cannot
    // accumulate one never-settling promise per structural event.
    await this.send(jobId, "progress", event, 2);
  }

  async result(jobId: string, result: ConnectorJobResult): Promise<void> {
    await this.send(jobId, "result", result);
  }

  async failure(jobId: string, code: string): Promise<void> {
    await this.send(jobId, "failure", { code });
  }

  async resourceResponse(response: ResourceExchangeResponse): Promise<void> {
    await this.send(response.requestId, "resources", response);
  }

  private async send(
    jobId: string,
    action: string,
    body: unknown,
    maximumReconnectAttempts = Number.POSITIVE_INFINITY,
  ): Promise<void> {
    const safeJobId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).parse(jobId);
    const response = await this.request(
      `/${encodeURIComponent(safeJobId)}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      maximumReconnectAttempts,
    );
    assertCredentialAccepted(response);
    if (!response.ok && response.status !== 409) {
      throw await connectorHttpResponseError(response, "job update");
    }
  }

  private request(
    pathname: string,
    init: RequestInit,
    maximumReconnectAttempts = Number.POSITIVE_INFINITY,
  ): Promise<Response> {
    return this.requestWithReconnect(pathname, init, maximumReconnectAttempts);
  }

  private async requestWithReconnect(
    pathname: string,
    init: RequestInit,
    maximumReconnectAttempts: number,
  ): Promise<Response> {
    const initialDelayMs = this.retryOptions.initialDelayMs ?? 500;
    const maximumDelayMs = this.retryOptions.maximumDelayMs ?? 30_000;
    const jitterRatio = this.retryOptions.jitterRatio ?? 0.2;
    if (
      !Number.isInteger(initialDelayMs) || initialDelayMs < 10 ||
      !Number.isInteger(maximumDelayMs) || maximumDelayMs < initialDelayMs ||
      !Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1
    ) {
      throw new Error("Connector retry policy is invalid");
    }
    const random = this.retryOptions.random ?? Math.random;
    const sleep = this.retryOptions.sleep ?? sleepForReconnect;
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImplementation(this.jobsUrl + pathname, {
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
      } catch (error) {
        if (init.signal?.aborted) throw error;
        attempt += 1;
        if (attempt > maximumReconnectAttempts) {
          throw new ConnectorTransportUnavailableError();
        }
        const delayMs = retryDelayMs(
          attempt,
          initialDelayMs,
          maximumDelayMs,
          jitterRatio,
          random,
        );
        this.retryOptions.onRetry?.({ attempt, delayMs });
        await sleep(delayMs, init.signal ?? undefined);
        continue;
      }
      if (!isTransientHttpStatus(response.status)) return response;
      await response.body?.cancel();
      attempt += 1;
      if (attempt > maximumReconnectAttempts) {
        throw new ConnectorTransportUnavailableError();
      }
      const delayMs = retryDelayMs(
        attempt,
        initialDelayMs,
        maximumDelayMs,
        jitterRatio,
        random,
      );
      this.retryOptions.onRetry?.({ attempt, delayMs });
      await sleep(delayMs, init.signal ?? undefined);
    }
  }
}

function assertCredentialAccepted(response: Readonly<Response>): void {
  if (response.status === 401 || response.status === 403) {
    throw new ConnectorCredentialRejectedError();
  }
}

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "UnknownError";
}

async function waitForRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  if (delayMs <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Pulls a turn's questions out of the answer it wrote them in.
 *
 * A model has exactly one channel back: the JSON object it was told to
 * produce. Its questions arrive inside that object and the cloud reads them
 * from the result envelope, so somebody has to move them across - and this is
 * the last place that is still on the asking developer's own machine.
 *
 * It is a copy, not a promotion. Nothing here is trusted: every entry is
 * re-validated against the same schema the owner's connector will enforce, a
 * shape that does not parse is dropped in silence rather than failing the
 * turn, and a request that survives still names either an identifier that
 * other machine minted or a sentence for its owner to read. Neither reaches a
 * file.
 *
 * The answer itself is passed on exactly as the model wrote it. The cloud
 * parses that against the protocol schema, and editing it here would be a
 * claim about somebody's turn that this function is not entitled to make.
 */
function liftResourceRequests(final: unknown): ConnectorResourceRequest[] {
  if (typeof final !== "object" || final === null) return [];
  const asks = (final as { resourceRequests?: unknown }).resourceRequests;
  if (!Array.isArray(asks)) return [];
  const lifted: ConnectorResourceRequest[] = [];
  for (const ask of asks.slice(0, MAX_LIFTED_RESOURCE_REQUESTS)) {
    const parsed = connectorResourceRequestSchema.safeParse(ask);
    if (parsed.success) lifted.push(parsed.data);
  }
  return lifted;
}

async function sleepForReconnect(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal) return waitForRetry(signal, delayMs);
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function retryDelayMs(
  attempt: number,
  initialDelayMs: number,
  maximumDelayMs: number,
  jitterRatio: number,
  random: () => number,
): number {
  const exponential = Math.min(
    maximumDelayMs,
    initialDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const boundedRandom = Math.min(1, Math.max(0, random()));
  const jitter = exponential * jitterRatio * (boundedRandom * 2 - 1);
  return Math.min(maximumDelayMs, Math.max(0, Math.round(exponential + jitter)));
}
