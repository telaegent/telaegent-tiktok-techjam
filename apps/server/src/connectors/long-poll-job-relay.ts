import { RunCancelledError } from "../errors.js";
import type { RuntimeProgressEvent, RuntimeProgressSink } from "../runtime-contract.js";
import { RuntimeProviderError } from "../runtime-errors.js";
import type { ConnectorPrincipal } from "../repository-proof/contract.js";
import type {
  ConnectorJobRelay,
  ConnectorJobRequest,
  ConnectorJobResult,
} from "./connector-turn-executor.js";
import type {
  ResourceExchangeRequest,
  ResourceExchangeResponse,
} from "./resource-exchange.js";

export type ConnectorDelivery =
  | { kind: "job"; job: Readonly<ConnectorJobRequest> }
  | { kind: "cancel"; jobId: string }
  | { kind: "resource_request"; request: Readonly<ResourceExchangeRequest> };

interface RegisteredBinding {
  principal: ConnectorPrincipal;
  githubRepositoryId: string;
  lastSeenAt: number;
}

interface PendingJob {
  job: Readonly<ConnectorJobRequest>;
  state: "queued" | "leased";
  onProgress?: RuntimeProgressSink | undefined;
  resolve: (result: ConnectorJobResult) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
  cancelRequested: boolean;
}

interface PollWaiter {
  principal: ConnectorPrincipal;
  /** Idempotent: clears the wait, releases the binding slot, answers the poll. */
  settle: (delivery: ConnectorDelivery | null) => void;
}

/**
 * One batch of resource requests waiting for the owning connector to answer.
 *
 * Delivered content passes through this object in flight and is handed to the
 * waiting caller unchanged. It is never logged, never written to a store, and
 * never outlives the promise it settles.
 */
interface PendingResourceExchange {
  request: ResourceExchangeRequest;
  state: "queued" | "leased";
  resolve: (response: ResourceExchangeResponse) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
  revokedResourceIds: Set<string>;
}

export interface LeasedResourceAuthorizationContext {
  authenticatedUserId: string;
  ownerUserId: string;
  githubRepositoryId: string;
  conversationId: string;
  taskId: string;
  grantId: string;
  resourceId: string;
  mode: "once" | "task";
  connectorBindingId: string;
}

interface PendingCancellation {
  principal: ConnectorPrincipal;
  jobId: string;
  timeout: NodeJS.Timeout;
}

export interface LongPollConnectorJobRelayOptions {
  jobTimeoutMs?: number;
  presenceTimeoutMs?: number;
  /**
   * How long the owning connector has to answer a resource batch. This is not
   * an approval deadline: the connector answers immediately, marking anything
   * a human has not approved as pending rather than waiting for them.
   */
  resourceTimeoutMs?: number;
  now?: () => number;
}

/**
 * Process-local cloud relay for the first outbound connector transport.
 *
 * Repository bindings remain durable in the authorization store. Jobs are
 * deliberately transient private work: they are bounded, leased to exactly
 * one authenticated connector, and disappear on completion, cancellation, or
 * timeout. Routes restore a ready binding from durable authorization state on
 * the connector's first authenticated request after a cloud restart.
 */
export class LongPollConnectorJobRelay implements ConnectorJobRelay {
  private readonly bindings = new Map<string, RegisteredBinding>();
  private readonly jobs = new Map<string, PendingJob>();
  private readonly jobIdByBinding = new Map<string, string>();
  private readonly waiters = new Map<string, PollWaiter>();
  private readonly cancellations = new Map<string, PendingCancellation>();
  private readonly resourceExchanges = new Map<string, PendingResourceExchange>();
  private readonly resourceQueueByBinding = new Map<string, string[]>();
  private readonly revokedGrants = new Map<
    string,
    Readonly<{ expiresAt: string | null; resourceId: string }>
  >();
  private readonly jobTimeoutMs: number;
  private readonly presenceTimeoutMs: number;
  private readonly resourceTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: LongPollConnectorJobRelayOptions = {}) {
    this.jobTimeoutMs = options.jobTimeoutMs ?? 300_000;
    this.presenceTimeoutMs = options.presenceTimeoutMs ?? 30_000;
    this.resourceTimeoutMs = options.resourceTimeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.jobTimeoutMs) || this.jobTimeoutMs < 1_000) {
      throw new Error("Connector job timeout is invalid");
    }
    if (!Number.isInteger(this.presenceTimeoutMs) || this.presenceTimeoutMs < 1_000) {
      throw new Error("Connector presence timeout is invalid");
    }
    if (!Number.isInteger(this.resourceTimeoutMs) || this.resourceTimeoutMs < 1_000) {
      throw new Error("Connector resource timeout is invalid");
    }
  }

  async unregisterPrincipal(principal: Readonly<ConnectorPrincipal>): Promise<void> {
    const repositories = new Set<string>();
    for (const registration of this.bindings.values()) {
      if (samePrincipal(registration.principal, principal)) {
        repositories.add(registration.githubRepositoryId);
      }
    }
    for (const githubRepositoryId of repositories) {
      await this.unregisterRepositoryBinding(principal, githubRepositoryId);
    }
  }

  /**
   * Removes only the caller's binding for one repository. A leased job gets a
   * short-lived, principal-bound cancellation tombstone so its connector can
   * still observe cancellation after the registration itself is removed.
   */
  async unregisterRepositoryBinding(
    principal: Readonly<ConnectorPrincipal>,
    githubRepositoryId: string,
  ): Promise<boolean> {
    let removed = false;
    for (const [bindingId, registration] of [...this.bindings]) {
      if (
        !samePrincipal(registration.principal, principal) ||
        registration.githubRepositoryId !== githubRepositoryId
      ) {
        continue;
      }
      await this.cancel(bindingId);
      this.abandonResourceExchanges(bindingId);
      this.waiters.get(bindingId)?.settle(null);
      this.bindings.delete(bindingId);
      removed = true;
    }
    return removed;
  }

  /**
   * Browser-side disconnect has a verified user identity but intentionally no
   * connector credential. Remove every process-local installation binding for
   * only that user × repository after the durable store has stopped it.
   */
  async unregisterUserRepositoryBindings(
    authenticatedUserId: string,
    githubRepositoryId: string,
  ): Promise<boolean> {
    let removed = false;
    for (const [bindingId, registration] of [...this.bindings]) {
      if (
        registration.principal.authenticatedUserId !== authenticatedUserId ||
        registration.githubRepositoryId !== githubRepositoryId
      ) {
        continue;
      }
      await this.cancel(bindingId);
      this.abandonResourceExchanges(bindingId);
      this.waiters.get(bindingId)?.settle(null);
      this.bindings.delete(bindingId);
      removed = true;
    }
    return removed;
  }

  registerBinding(
    principal: Readonly<ConnectorPrincipal>,
    connectorBindingId: string,
    githubRepositoryId = "1",
  ): void {
    // A recovered binding must not inherit an expired authorization epoch's
    // cancellation. Do not clear a live binding's cancellation during a
    // harmless proof replay, because its leased provider may still be stopping.
    if (!this.bindings.has(connectorBindingId)) {
      this.clearCancellation(connectorBindingId);
    }
    this.bindings.set(connectorBindingId, {
      principal: { ...principal },
      githubRepositoryId,
      lastSeenAt: this.now(),
    });
  }

  async dispatch<T = unknown>(
    job: Readonly<ConnectorJobRequest>,
    onProgress?: RuntimeProgressSink,
  ): Promise<ConnectorJobResult<T>> {
    const registration = this.bindings.get(job.connectorBindingId);
    if (
      !registration ||
      registration.principal.authenticatedUserId !== job.userId ||
      registration.githubRepositoryId !== job.githubRepositoryId ||
      this.now() - registration.lastSeenAt > this.presenceTimeoutMs
    ) {
      throw unavailable();
    }
    if (this.jobs.has(job.jobId) || this.jobIdByBinding.has(job.connectorBindingId)) {
      throw new RuntimeProviderError(
        "RUNTIME_UNAVAILABLE",
        "Local connector is already running a job for this repository",
      );
    }

    return await new Promise<ConnectorJobResult<T>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.jobs.get(job.jobId);
        if (!pending) return;
        this.removeJob(pending);
        reject(new RuntimeProviderError("RUNTIME_TIMEOUT", "Local connector job timed out"));
      }, this.jobTimeoutMs);
      timeout.unref?.();
      const pending: PendingJob = {
        job: structuredClone(job),
        state: "queued",
        onProgress,
        resolve: resolve as (result: ConnectorJobResult) => void,
        reject,
        timeout,
        cancelRequested: false,
      };
      this.jobs.set(job.jobId, pending);
      this.jobIdByBinding.set(job.connectorBindingId, job.jobId);
      this.wake(job.connectorBindingId);
    });
  }

  registeredRepository(
    principal: Readonly<ConnectorPrincipal>,
    connectorBindingId: string,
  ): string {
    this.assertBindingOwner(principal, connectorBindingId);
    return this.bindings.get(connectorBindingId)!.githubRepositoryId;
  }

  /** Safe browser-facing presence check: no principal, path, or job data leaves. */
  isBindingOnline(authenticatedUserId: string, connectorBindingId: string): boolean {
    const registration = this.bindings.get(connectorBindingId);
    return Boolean(
      registration &&
      registration.principal.authenticatedUserId === authenticatedUserId &&
      (
        this.now() - registration.lastSeenAt <= this.presenceTimeoutMs ||
        this.jobIdByBinding.has(connectorBindingId)
      ),
    );
  }

  async cancel(connectorBindingId: string): Promise<boolean> {
    const jobId = this.jobIdByBinding.get(connectorBindingId);
    const pending = jobId ? this.jobs.get(jobId) : undefined;
    if (!pending) return false;
    pending.cancelRequested = true;
    if (pending.state === "leased") {
      const registration = this.bindings.get(connectorBindingId);
      if (registration) {
        this.setCancellation(
          connectorBindingId,
          registration.principal,
          pending.job.jobId,
        );
      }
    }
    this.removeJob(pending);
    pending.reject(new RunCancelledError());
    this.wake(connectorBindingId);
    return true;
  }

  /**
   * `abandoned` reports that the polling connector is gone. A binding holds at
   * most one waiter, so an abandoned wait that outlived its client would reject
   * the connector's next poll and strand it after a single job.
   */
  async poll(
    principal: Readonly<ConnectorPrincipal>,
    connectorBindingId: string,
    waitMs: number,
    abandoned?: AbortSignal,
  ): Promise<ConnectorDelivery | null> {
    const cancellation = this.takeCancellation(principal, connectorBindingId);
    if (cancellation) return cancellation;
    this.assertBindingOwner(principal, connectorBindingId);
    const registration = this.bindings.get(connectorBindingId)!;
    registration.lastSeenAt = this.now();
    const immediate = this.takeDelivery(principal, connectorBindingId);
    if (immediate || waitMs === 0) return immediate;
    if (abandoned?.aborted) return null;
    if (this.waiters.has(connectorBindingId)) {
      throw new RuntimeProviderError(
        "UNSUPPORTED_RUNTIME_POLICY",
        "Connector already has an active poll for this binding",
      );
    }
    return await new Promise((resolve) => {
      let settled = false;
      const settle = (delivery: ConnectorDelivery | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        abandoned?.removeEventListener("abort", release);
        if (this.waiters.get(connectorBindingId) === waiter) {
          this.waiters.delete(connectorBindingId);
        }
        resolve(delivery);
      };
      const release = (): void => settle(null);
      const timeout = setTimeout(release, waitMs);
      timeout.unref?.();
      const waiter: PollWaiter = { principal: { ...principal }, settle };
      this.waiters.set(connectorBindingId, waiter);
      abandoned?.addEventListener("abort", release, { once: true });
    });
  }

  /**
   * Asks the owning connector to serve one batch of resource requests.
   *
   * The cloud routes; it does not decide. Every grant here is an assertion the
   * connector re-checks against its own registry, policy engine and workspace
   * boundary before any byte is read, and the connector may still refuse.
   */
  async exchangeResources(
    request: Readonly<ResourceExchangeRequest>,
  ): Promise<ResourceExchangeResponse> {
    const registration = this.bindings.get(request.connectorBindingId);
    if (
      !registration ||
      this.now() - registration.lastSeenAt > this.presenceTimeoutMs
    ) {
      throw unavailable();
    }
    if (this.resourceExchanges.has(request.requestId)) {
      throw new RuntimeProviderError(
        "UNSUPPORTED_RUNTIME_POLICY",
        "Resource request identifier is already in flight",
      );
    }

    return await new Promise<ResourceExchangeResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.resourceExchanges.get(request.requestId);
        if (!pending) return;
        this.removeResourceExchange(request.requestId, pending);
        reject(
          new RuntimeProviderError(
            "RUNTIME_TIMEOUT",
            "Local connector did not answer the resource request",
          ),
        );
      }, this.resourceTimeoutMs);
      timeout.unref?.();
      const sanitized = this.applyGrantRevocations(
        structuredClone(request) as ResourceExchangeRequest,
      );
      this.resourceExchanges.set(request.requestId, {
        request: sanitized,
        state: "queued",
        resolve,
        reject,
        timeout,
        revokedResourceIds: new Set(
          sanitized.revokedGrants?.flatMap((revoked) => {
            const match = request.grants.find(
              (grant) => grant.grantId === revoked.grantId,
            );
            return match &&
              !sanitized.grants.some(
                (remaining) => remaining.resourceId === match.resourceId,
              )
              ? [match.resourceId]
              : [];
          }) ?? [],
        ),
      });
      const queue = this.resourceQueueByBinding.get(request.connectorBindingId) ?? [];
      queue.push(request.requestId);
      this.resourceQueueByBinding.set(request.connectorBindingId, queue);
      this.wake(request.connectorBindingId);
    });
  }

  /**
   * Linearizes browser revocation with queued connector reads. A tombstone is
   * retained through the grant lifetime, stripped from every stale batch, and
   * sent to the connector so its local reference monitor remembers it too.
   * Leased replies are filtered as a final barrier if revocation wins while a
   * connector is already reading.
   */
  revokeCapabilityGrant(
    grant: Readonly<{ grantId: string; resourceId: string; expiresAt: string }>,
  ): void {
    this.revokedGrants.set(grant.grantId, {
      expiresAt: grant.expiresAt,
      resourceId: grant.resourceId,
    });
    for (const pending of this.resourceExchanges.values()) {
      const revoked = pending.request.grants.filter(
        (assertion) => assertion.grantId === grant.grantId,
      );
      pending.request.grants = pending.request.grants.filter(
        (assertion) => assertion.grantId !== grant.grantId,
      );
      for (const assertion of revoked) {
        if (
          !pending.request.grants.some(
            (remaining) => remaining.resourceId === assertion.resourceId,
          )
        ) {
          pending.revokedResourceIds.add(assertion.resourceId);
        }
        pending.request.revokedGrants = mergeRevocations(
          pending.request.revokedGrants,
          { grantId: grant.grantId, expiresAt: grant.expiresAt },
        );
      }
    }
  }

  /**
   * Derives a pre-read authorization query exclusively from a leased envelope
   * and its authenticated owner connector. Caller-supplied identifiers may
   * select an existing assertion, but can never widen or synthesize one.
   */
  leasedResourceAuthorization(
    principal: Readonly<ConnectorPrincipal>,
    requestId: string,
    selector: Readonly<{ grantId: string; resourceId: string }>,
  ): LeasedResourceAuthorizationContext | null {
    const pending = this.resourceExchanges.get(requestId);
    if (!pending || pending.state !== "leased") return null;
    const binding = this.bindings.get(pending.request.connectorBindingId);
    if (!binding || !samePrincipal(binding.principal, principal)) return null;
    if (
      !pending.request.requests.some(
        (item) => item.kind === "resource" && item.resourceId === selector.resourceId,
      )
    ) {
      return null;
    }
    const grant = pending.request.grants.find(
      (item) =>
        item.grantId === selector.grantId &&
        item.resourceId === selector.resourceId &&
        item.operation === "read",
    );
    if (!grant || pending.revokedResourceIds.has(selector.resourceId)) return null;
    return {
      authenticatedUserId: pending.request.peerUserId,
      ownerUserId: principal.authenticatedUserId,
      githubRepositoryId: binding.githubRepositoryId,
      conversationId: pending.request.conversationId,
      taskId: pending.request.taskId,
      grantId: grant.grantId,
      resourceId: grant.resourceId,
      mode: grant.mode,
      connectorBindingId: pending.request.connectorBindingId,
    };
  }

  /**
   * Accepts the owning connector's answer to a leased resource batch.
   *
   * Outcomes are positional: the caller matches answer n to request n, so a
   * response of a different length is rejected rather than reinterpreted. A
   * mismatched length could otherwise shift one file's bytes onto another
   * file's request.
   */
  completeResourceExchange(
    principal: Readonly<ConnectorPrincipal>,
    requestId: string,
    response: Readonly<ResourceExchangeResponse>,
  ): boolean {
    const pending = this.resourceExchanges.get(requestId);
    if (!pending || pending.state !== "leased") return false;
    const registration = this.bindings.get(pending.request.connectorBindingId);
    if (!registration || !samePrincipal(registration.principal, principal)) return false;
    if (
      response.requestId !== requestId ||
      response.outcomes.length !== pending.request.requests.length
    ) {
      return false;
    }
    this.removeResourceExchange(requestId, pending);
    const safeResponse = structuredClone(response) as ResourceExchangeResponse;
    safeResponse.outcomes = safeResponse.outcomes.map((outcome, index) => {
      const requested = pending.request.requests[index];
      return (
        pending.revokedResourceIds.has(
          outcome.status === "delivered"
            ? outcome.resourceId
            : requested?.kind === "resource"
              ? requested.resourceId
              : "",
        )
      ) ? { status: "refused" as const } : outcome;
    });
    pending.resolve(safeResponse);
    return true;
  }

  publishProgress(
    principal: Readonly<ConnectorPrincipal>,
    jobId: string,
    event: RuntimeProgressEvent,
  ): boolean {
    const pending = this.ownedLeasedJob(principal, jobId);
    if (!pending) return false;
    try {
      pending.onProgress?.(structuredClone(event));
    } catch {
      // Browser progress is best-effort and cannot fail connector execution.
    }
    return true;
  }

  complete(
    principal: Readonly<ConnectorPrincipal>,
    jobId: string,
    result: Readonly<ConnectorJobResult>,
  ): boolean {
    const pending = this.ownedLeasedJob(principal, jobId);
    if (!pending) return false;
    this.removeJob(pending);
    pending.resolve(structuredClone(result));
    return true;
  }

  fail(
    principal: Readonly<ConnectorPrincipal>,
    jobId: string,
    code: RuntimeProviderError["code"],
  ): boolean {
    const pending = this.ownedLeasedJob(principal, jobId);
    if (!pending) return false;
    this.removeJob(pending);
    pending.reject(new RuntimeProviderError(code, safeFailureMessage(code)));
    return true;
  }

  private takeDelivery(
    principal: Readonly<ConnectorPrincipal>,
    connectorBindingId: string,
  ): ConnectorDelivery | null {
    const cancellation = this.takeCancellation(principal, connectorBindingId);
    if (cancellation) return cancellation;
    // A resource batch is a bounded, provider-free reference-monitor operation
    // that returns in milliseconds. Serving it ahead of a queued job stops a
    // peer's follow-up from waiting behind a turn that may run for minutes; the
    // job stays queued and loses nothing by being taken one poll later.
    const exchange = this.takeResourceExchange(connectorBindingId);
    if (exchange) return exchange;
    const jobId = this.jobIdByBinding.get(connectorBindingId);
    const pending = jobId ? this.jobs.get(jobId) : undefined;
    if (!pending) return null;
    if (pending.cancelRequested) return { kind: "cancel", jobId: pending.job.jobId };
    if (pending.state === "leased") return null;
    pending.state = "leased";
    return { kind: "job", job: structuredClone(pending.job) };
  }

  private wake(connectorBindingId: string): void {
    const waiter = this.waiters.get(connectorBindingId);
    if (!waiter) return;
    const delivery = this.takeDelivery(waiter.principal, connectorBindingId);
    if (!delivery) return;
    waiter.settle(delivery);
  }

  private assertBindingOwner(
    principal: Readonly<ConnectorPrincipal>,
    connectorBindingId: string,
  ): void {
    const registration = this.bindings.get(connectorBindingId);
    if (!registration || !samePrincipal(registration.principal, principal)) {
      throw new RuntimeProviderError(
        "UNSUPPORTED_RUNTIME_POLICY",
        "Connector binding is not authorized for this connector",
      );
    }
  }

  private ownedLeasedJob(
    principal: Readonly<ConnectorPrincipal>,
    jobId: string,
  ): PendingJob | null {
    const pending = this.jobs.get(jobId);
    if (!pending || pending.state !== "leased") return null;
    const registration = this.bindings.get(pending.job.connectorBindingId);
    return registration && samePrincipal(registration.principal, principal)
      ? pending
      : null;
  }

  private takeResourceExchange(connectorBindingId: string): ConnectorDelivery | null {
    const queue = this.resourceQueueByBinding.get(connectorBindingId);
    if (!queue) return null;
    while (queue.length > 0) {
      const requestId = queue.shift()!;
      const pending = this.resourceExchanges.get(requestId);
      if (!pending || pending.state !== "queued") continue;
      pending.state = "leased";
      if (queue.length === 0) this.resourceQueueByBinding.delete(connectorBindingId);
      return {
        kind: "resource_request",
        request: structuredClone(pending.request) as ResourceExchangeRequest,
      };
    }
    this.resourceQueueByBinding.delete(connectorBindingId);
    return null;
  }

  private applyGrantRevocations(request: ResourceExchangeRequest): ResourceExchangeRequest {
    const now = this.now();
    for (const [grantId, revoked] of this.revokedGrants) {
      if (revoked.expiresAt !== null && Date.parse(revoked.expiresAt) <= now) {
        this.revokedGrants.delete(grantId);
      }
    }
    for (const grant of request.grants) {
      const revoked = this.revokedGrants.get(grant.grantId);
      if (!revoked) continue;
      request.revokedGrants = mergeRevocations(request.revokedGrants, {
        grantId: grant.grantId,
        expiresAt: revoked.expiresAt,
      });
    }
    request.grants = request.grants.filter(
      (grant) => !this.revokedGrants.has(grant.grantId),
    );
    return request;
  }

  private removeResourceExchange(
    requestId: string,
    pending: PendingResourceExchange,
  ): void {
    clearTimeout(pending.timeout);
    this.resourceExchanges.delete(requestId);
  }

  /** A binding that is gone cannot answer, so its callers fail closed now. */
  private abandonResourceExchanges(connectorBindingId: string): void {
    for (const [requestId, pending] of [...this.resourceExchanges]) {
      if (pending.request.connectorBindingId !== connectorBindingId) continue;
      this.removeResourceExchange(requestId, pending);
      pending.reject(unavailable());
    }
    this.resourceQueueByBinding.delete(connectorBindingId);
  }

  private removeJob(pending: PendingJob): void {
    clearTimeout(pending.timeout);
    this.jobs.delete(pending.job.jobId);
    this.jobIdByBinding.delete(pending.job.connectorBindingId);
  }

  private setCancellation(
    connectorBindingId: string,
    principal: Readonly<ConnectorPrincipal>,
    jobId: string,
  ): void {
    this.clearCancellation(connectorBindingId);
    const timeout = setTimeout(
      () => this.clearCancellation(connectorBindingId),
      this.presenceTimeoutMs,
    );
    timeout.unref?.();
    this.cancellations.set(connectorBindingId, {
      principal: { ...principal },
      jobId,
      timeout,
    });
  }

  private takeCancellation(
    principal: Readonly<ConnectorPrincipal>,
    connectorBindingId: string,
  ): ConnectorDelivery | null {
    const cancellation = this.cancellations.get(connectorBindingId);
    if (!cancellation || !samePrincipal(cancellation.principal, principal)) {
      return null;
    }
    this.clearCancellation(connectorBindingId);
    return { kind: "cancel", jobId: cancellation.jobId };
  }

  private clearCancellation(connectorBindingId: string): void {
    const cancellation = this.cancellations.get(connectorBindingId);
    if (!cancellation) return;
    clearTimeout(cancellation.timeout);
    this.cancellations.delete(connectorBindingId);
  }
}

function samePrincipal(
  left: Readonly<ConnectorPrincipal>,
  right: Readonly<ConnectorPrincipal>,
): boolean {
  return (
    left.authenticatedUserId === right.authenticatedUserId &&
    left.connectorInstanceId === right.connectorInstanceId
  );
}

function unavailable(): RuntimeProviderError {
  return new RuntimeProviderError(
    "RUNTIME_UNAVAILABLE",
    "No authenticated local connector is attached to this runtime binding",
  );
}

function mergeRevocations(
  existing: ResourceExchangeRequest["revokedGrants"],
  revoked: Readonly<{ grantId: string; expiresAt: string | null }>,
): NonNullable<ResourceExchangeRequest["revokedGrants"]> {
  return [
    ...(existing ?? []).filter((item) => item.grantId !== revoked.grantId),
    { ...revoked },
  ].slice(-64);
}

function safeFailureMessage(code: RuntimeProviderError["code"]): string {
  switch (code) {
    case "RUNTIME_AUTHENTICATION_FAILED":
      return "Local provider authentication is required";
    case "RUNTIME_SESSION_NOT_FOUND":
      return "Local provider session was not found";
    case "RUNTIME_TIMEOUT":
      return "Local provider runtime timed out";
    case "RUNTIME_OUTPUT_LIMIT":
      return "Local provider output exceeded its limit";
    case "INVALID_AGENT_OUTPUT":
      return "Local provider returned invalid output";
    case "UNSUPPORTED_RUNTIME_POLICY":
      return "Local connector rejected the runtime policy";
    case "RUNTIME_UNAVAILABLE":
      return "Local provider runtime is unavailable";
    default:
      return "Local provider runtime failed";
  }
}
