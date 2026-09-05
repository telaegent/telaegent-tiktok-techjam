import path from "node:path";
import { z } from "zod";
import type {
  ManagedAgentTurnRequest,
  ManagedAgentTurnResult,
  ProviderSessionManager,
  ProviderSessionScope,
} from "../provider-session-manager.js";
import type { RuntimeProgressEvent } from "../runtime-contract.js";
import { buildInvestigationPrompt } from "../telagent/protocol/prompts/investigate.js";
import {
  RuntimeProviderError,
  normalizeRuntimeFailure,
  type LocalRuntimeFailurePhase,
} from "../runtime-errors.js";
import type {
  ConnectorJobRequest,
  ConnectorJobResult,
} from "./connector-turn-executor.js";
import { CONNECTOR_INVESTIGATION_DEADLINE_MS } from "./connector-turn-executor.js";
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
import { projectRelativeDisplayLabel } from "./workspace-label.js";

/**
 * The bound the connector result route enforces. Applied here too so an
 * over-curious turn is trimmed on the machine that produced it rather than
 * rejected in transport, which would lose the answer along with the questions.
 */
const MAX_LIFTED_RESOURCE_REQUESTS = 16;

/**
 * The investigation pass's budget.
 *
 * It is larger than any drafting budget on purpose, and it is safe to be
 * larger for a structural reason rather than a policy one: this pass is bound
 * to a one-field output schema, so it has no shape in which to return a
 * message, a state, or a resource request. It can read and it cannot send.
 *
 * The cloud never selects it. `jobSchema` still refuses any purpose other than
 * the two drafting purposes and any `maxTurns` above 3; this request is built
 * here, from a job that already passed that check.
 */
/**
 * Eight, and a backstop rather than a plan.
 *
 * Neither limit around this pass is one the model can steer by. It cannot see
 * the clock, and the CLI's turn accounting is not the model's: a run capped at
 * three turns was measured emitting eleven assistant messages. What it can count
 * is its own tool calls, so the prompt budgets five of them, and this cap sits
 * above where a pass that respects that budget lands.
 *
 * Both limits are equally bad when they fire, which is why neither is the plan.
 * The turn cap does not let the pass finish the turn it is on -- it ends the run
 * with `error_max_turns` and no structured output, just as the deadline ends it
 * with no result event at all. Nothing is recoverable afterwards either: a
 * research pass speaks in tool calls and thinking, and a successful twelve-tool
 * investigation was measured emitting zero characters of assistant text. Either
 * this pass returns its own note or the drafting pass has none.
 */
const INVESTIGATION_MAX_TURNS = 8;
const INVESTIGATION_SCHEMA_NAME = "investigation-note.schema.json";

/**
 * The drafting pass reasons at medium, not at the CLI default of maximum.
 *
 * Effort buys deliberation, and deliberation is what the research pass is for.
 * By the time this pass runs the files have been read and the findings are in
 * the note; what remains is to compose one JSON object under a schema that
 * names every field and states every invariant in prose. Measured against the
 * drafting prompt with a populated research note: 38.6s unset, 23.0s at
 * medium, and the difference is entirely thinking emitted before the first
 * character of the answer -- 1123 thinking tokens down to 153, first character
 * at 21.1s down to 5.5s, the answer itself unchanged at ~4100 characters.
 *
 * Medium rather than low because this pass still makes judgements the owner
 * sees -- which state to file the turn under, what to flag, what the note did
 * not establish. Low reached 14.2s on the same prompt but returned 2425
 * characters against medium's 4131: part of its speed is a shorter answer, not
 * a faster one. If the seconds are needed, take them from the schema's
 * maxLength where the trade is explicit, not from here where it is a side
 * effect.
 *
 * Do not read the earlier 23.3s/11.8s/7.9s figures in the history of this
 * comment as the same measurement. Those ran the drafting prompt with an empty
 * note, where thinking was nearly the whole pass; they described a stub.
 */
const DRAFTING_EFFORT = "medium" as const;

/**
 * The research pass's share of the cloud's job budget.
 *
 * `LongPollConnectorJobRelay` times a job out at `max(CLAUDE_TIMEOUT_MS,
 * CODEX_TIMEOUT_MS)`, and that budget covers the whole job while the provider
 * timeout of the same name bounds one run. Before two passes those two limits
 * described the same interval. They no longer do: an investigation that runs
 * long spends budget the drafting pass still needs, and the owner sees the job
 * time out — indistinguishable, from the outside, from a dropped connector.
 *
 * A turn cap is not a time cap. Twelve turns of `Grep` over a large repository
 * can outlast twelve turns of anything else, so the bound has to be wall clock.
 * Crossing it aborts the research pass alone; the drafting pass then runs with
 * the original prompt and the rest of the budget, exactly as it did before this
 * existed.
 */
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
  result(jobId: string, result: ConnectorJobResult, signal?: AbortSignal): Promise<void>;
  failure(jobId: string, code: string, signal?: AbortSignal): Promise<void>;
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
  /** Hard deadline for one network attempt, including a stalled TCP socket. */
  requestTimeoutMs?: number;
  jitterRatio?: number;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (event: Readonly<{ attempt: number; delayMs: number }>) => void;
  onRecovered?: (event: Readonly<{ attempts: number }>) => void;
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

  async runOnce(signal?: AbortSignal): Promise<"idle" | "completed" | "cancelled"> {
    await this.pruneExpiredResources();
    const untrustedDelivery = await this.transport.poll(signal);
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
    let externallyAborted = signal?.aborted ?? false;
    let credentialRejection: ConnectorCredentialRejectedError | undefined;
    const abortExecution = () => {
      externallyAborted = true;
      cancellationController.abort();
      executionController.abort();
    };
    signal?.addEventListener("abort", abortExecution, { once: true });
    if (externallyAborted) abortExecution();
    const execution = this.runTurn(job, executionController.signal);
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
      }, signal);
      return "completed";
    } catch (error) {
      if (credentialRejection) throw credentialRejection;
      if (error instanceof ConnectorCredentialRejectedError) throw error;
      if (externallyAborted) return "cancelled";
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
      await this.transport.failure(job.jobId, failure.code, signal);
      return "completed";
    } finally {
      signal?.removeEventListener("abort", abortExecution);
      cancellationController.abort();
      // Joining the watcher is cleanup, and cleanup may not overwrite the turn's
      // verdict. Aborting that watcher one line above is itself a routine reason
      // for it to reject, so throwing here replaced an already durable
      // "completed" with that abort, and the caller reported it as the
      // provider's own failure. Whatever the watcher had to say was raced into
      // the try block through `cancellationFailure`; by this point it has been
      // classified already or been overtaken by the turn's own outcome.
      await cancellation.catch(() => undefined);
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
      if (delivery?.kind === "resource_request") {
        // The relay prioritizes resource exchange over new jobs. Serving it
        // here prevents an active provider turn from consuming and silently
        // discarding a request intended for that same connector binding.
        await this.serveResourceRequest(delivery.request);
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

  /**
   * One private turn: research, then draft.
   *
   * Both passes live inside this single promise so `runOnce`'s cancellation
   * watcher, abort signal, and cleanup cover the investigation exactly as they
   * cover the draft. Splitting them would leave the longer pass unwatched.
   */
  private async runTurn(
    job: Readonly<ConnectorJobRequest>,
    signal: AbortSignal,
  ): Promise<ManagedAgentTurnResult> {
    const investigationNote = await this.investigate(job, signal);
    return await this.sessions.run(
      this.scope(job),
      this.request(job, investigationNote),
      (event) => {
        this.forwardProgress(job.jobId, event);
      },
      undefined,
      undefined,
      signal,
    );
  }

  /**
   * The research pass. Its note never leaves this process.
   *
   * Failure is not an error: a turn that could not investigate is still a turn
   * the owner is waiting for, so a failed or overrunning research pass returns
   * an empty note and lets the drafting pass run exactly as it did before two
   * passes existed. Cancellation is the one exception — see the catch.
   */
  private async investigate(
    job: Readonly<ConnectorJobRequest>,
    signal: AbortSignal,
  ): Promise<string> {
    const deadline = new AbortController();
    const stopInvestigating = (): void => {
      deadline.abort();
    };
    signal.addEventListener("abort", stopInvestigating, { once: true });
    const timer = setTimeout(
      stopInvestigating,
      CONNECTOR_INVESTIGATION_DEADLINE_MS,
    );
    timer.unref?.();
    try {
      const result = await this.sessions.run(
        this.scope(job),
        {
          agentId: this.binding.connectorBindingId,
          connectorBindingId: this.binding.connectorBindingId,
          workspacePath: this.binding.workspacePath,
          purpose: job.purpose,
          runtimePrompt: buildInvestigationPrompt(job.runtimePrompt),
          persistedSummary: job.persistedSummary,
          // A research pass must not consume, rotate, or pollute the
          // conversation's provider session.
          sessionMode: "ephemeral",
          sandboxMode: job.sandboxMode,
          networkMode: job.networkMode,
          outputSchemaName: INVESTIGATION_SCHEMA_NAME,
          correlationId: job.correlationId,
          maxTurns: INVESTIGATION_MAX_TURNS,
        },
        (event) => {
          this.forwardProgress(job.jobId, event);
        },
        undefined,
        undefined,
        deadline.signal,
      );
      const note = (result.final as { note?: unknown } | null)?.note;
      return typeof note === "string" ? note : "";
    } catch (error) {
      // A cancelled job is not a failed investigation. The owner asked the whole
      // turn to stop, so this must not be swallowed into a drafting pass nobody
      // is waiting for.
      if (signal.aborted) throw error;
      // Anything else — the deadline included — is an enhancement that did not
      // arrive. Degrade to the single-pass turn.
      return "";
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stopInvestigating);
    }
  }

  private request(
    job: Readonly<ConnectorJobRequest>,
    investigationNote: string,
  ): ManagedAgentTurnRequest {
    return {
      agentId: this.binding.connectorBindingId,
      connectorBindingId: this.binding.connectorBindingId,
      workspacePath: this.binding.workspacePath,
      purpose: job.purpose,
      runtimePrompt: investigationNote
        ? [
            job.runtimePrompt,
            "Findings from your own research pass in this repository. They are"
              + " yours, not a message from anyone: treat them as notes you took"
              + " a moment ago. They may stop mid-thought, because that pass has"
              + " a deadline. You cannot open a file in this turn, so say plainly"
              + " what the notes did not establish rather than filling the gap"
              + " from memory.",
            investigationNote,
          ].join("\n\n")
        : job.runtimePrompt,
      persistedSummary: job.persistedSummary,
      sessionMode: job.sessionMode,
      sandboxMode: job.sandboxMode,
      networkMode: job.networkMode,
      outputSchemaName: job.outputSchemaName,
      correlationId: job.correlationId,
      maxTurns: job.maxTurns,
      // This pass writes. The pass before it read, and the note above is the
      // evidence it produced; anything not in the note is not established.
      // Reading here is what used to fail the turn outright: with two turns and
      // file tools, a note-less drafting pass spends both on reads and never
      // reaches structured output. Without tools it answers from what it has,
      // and says so when that is nothing.
      toolMode: "none",
      // The thinking this pass would do at full effort was already done by the
      // pass before it, against the actual files. What is left is composition:
      // turn a note and a message into one JSON object under a schema that
      // spells out every field. Measured on a scheduling message, full effort
      // spent 13 of its 23 seconds thinking before writing a single character.
      effort: DRAFTING_EFFORT,
    };
  }

  /**
   * The single point where provider progress crosses into cloud custody.
   *
   * Raw provider text never crosses. An activity target does, but only after
   * the same containment check that governs resource delivery reduces it to a
   * workspace-relative label; anything resolving outside the workspace loses
   * its target and travels as the bare activity it is today.
   */
  private forwardProgress(jobId: string, event: RuntimeProgressEvent): void {
    if (event.type === "text_delta") return;
    const contained = this.containActivityTarget(event);
    void this.transport.progress(jobId, contained).catch(() => undefined);
  }

  private containActivityTarget(event: RuntimeProgressEvent): RuntimeProgressEvent {
    if (event.type !== "activity_started" && event.type !== "activity_completed") {
      return event;
    }
    if (event.target === undefined) return event;
    const label = projectRelativeDisplayLabel(this.binding.workspacePath, event.target);
    if (label === null) {
      const { target: _dropped, ...rest } = event;
      return rest;
    }
    return { ...event, target: label };
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

  async result(
    jobId: string,
    result: ConnectorJobResult,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.send(jobId, "result", result, Number.POSITIVE_INFINITY, signal);
  }

  async failure(jobId: string, code: string, signal?: AbortSignal): Promise<void> {
    await this.send(jobId, "failure", { code }, Number.POSITIVE_INFINITY, signal);
  }

  async resourceResponse(response: ResourceExchangeResponse): Promise<void> {
    await this.send(response.requestId, "resources", response);
  }

  private async send(
    jobId: string,
    action: string,
    body: unknown,
    maximumReconnectAttempts = Number.POSITIVE_INFINITY,
    signal?: AbortSignal,
  ): Promise<void> {
    const safeJobId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).parse(jobId);
    const response = await this.request(
      `/${encodeURIComponent(safeJobId)}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
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
    const requestTimeoutMs = this.retryOptions.requestTimeoutMs ?? 35_000;
    const jitterRatio = this.retryOptions.jitterRatio ?? 0.2;
    if (
      !Number.isInteger(initialDelayMs) || initialDelayMs < 10 ||
      !Number.isInteger(maximumDelayMs) || maximumDelayMs < initialDelayMs ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 10 ||
      !Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1
    ) {
      throw new Error("Connector retry policy is invalid");
    }
    const random = this.retryOptions.random ?? Math.random;
    const sleep = this.retryOptions.sleep ?? sleepForReconnect;
    let attempt = 0;
    for (;;) {
      let response: Response;
      const deadline = requestDeadline(init.signal ?? undefined, requestTimeoutMs);
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
          signal: deadline.signal,
        });
      } catch (error) {
        deadline.release();
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
        safeRetryNotification(this.retryOptions.onRetry, { attempt, delayMs });
        await sleep(delayMs, init.signal ?? undefined);
        continue;
      }
      deadline.release();
      if (!isTransientHttpStatus(response.status)) {
        if (attempt > 0 && (response.ok || response.status === 409)) {
          safeRecoveryNotification(this.retryOptions.onRecovered, { attempts: attempt });
        }
        return response;
      }
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
      safeRetryNotification(this.retryOptions.onRetry, { attempt, delayMs });
      await sleep(delayMs, init.signal ?? undefined);
    }
  }
}

function requestDeadline(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): Readonly<{ signal: AbortSignal; release: () => void }> {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function safeRetryNotification(
  notifyRetry: ConnectorTransportRetryOptions["onRetry"],
  event: Readonly<{ attempt: number; delayMs: number }>,
): void {
  try {
    notifyRetry?.(event);
  } catch {
    // Local diagnostics are advisory and cannot break reconnection.
  }
}

function safeRecoveryNotification(
  notifyRecovery: ConnectorTransportRetryOptions["onRecovered"],
  event: Readonly<{ attempts: number }>,
): void {
  try {
    notifyRecovery?.(event);
  } catch {
    // Local diagnostics are advisory and cannot break a recovered connection.
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
