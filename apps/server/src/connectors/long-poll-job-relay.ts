import { RunCancelledError } from "../errors.js";
import type { RuntimeProgressEvent, RuntimeProgressSink } from "../runtime-contract.js";
import { RuntimeProviderError } from "../runtime-errors.js";
import type { ConnectorPrincipal } from "../repository-proof/contract.js";
import type {
  ConnectorJobRelay,
  ConnectorJobRequest,
  ConnectorJobResult,
} from "./connector-turn-executor.js";
import type { ResourceExchangeRequest } from "./resource-exchange.js";

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

interface PendingCancellation {
  principal: ConnectorPrincipal;
  jobId: string;
  timeout: NodeJS.Timeout;
}

export interface LongPollConnectorJobRelayOptions {
  jobTimeoutMs?: number;
  presenceTimeoutMs?: number;
  now?: () => number;
}

/**
 * Process-local cloud relay for the first outbound connector transport.
 *
 * Repository bindings remain durable in the authorization store. Jobs are
 * deliberately transient private work: they are bounded, leased to exactly
 * one authenticated connector, and disappear on completion, cancellation, or
 * timeout. A connector must re-register its proven binding after cloud restart.
 */
export class LongPollConnectorJobRelay implements ConnectorJobRelay {
  private readonly bindings = new Map<string, RegisteredBinding>();
  private readonly jobs = new Map<string, PendingJob>();
  private readonly jobIdByBinding = new Map<string, string>();
  private readonly waiters = new Map<string, PollWaiter>();
  private readonly cancellations = new Map<string, PendingCancellation>();
  private readonly jobTimeoutMs: number;
  private readonly presenceTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: LongPollConnectorJobRelayOptions = {}) {
    this.jobTimeoutMs = options.jobTimeoutMs ?? 300_000;
    this.presenceTimeoutMs = options.presenceTimeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.jobTimeoutMs) || this.jobTimeoutMs < 1_000) {
      throw new Error("Connector job timeout is invalid");
    }
    if (!Number.isInteger(this.presenceTimeoutMs) || this.presenceTimeoutMs < 1_000) {
      throw new Error("Connector presence timeout is invalid");
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
