import {
  REPOSITORY_REVALIDATION_INTERVAL_MS,
  REPOSITORY_REVALIDATION_RETRY_MS,
} from "../repository-proof/lifetime.js";

export interface ConnectorRepositoryRevalidatorEvents {
  onRetry?: ((event: { attempt: number; delayMs: number }) => void) | undefined;
  onRecovered?: ((event: { attempts: number }) => void) | undefined;
}

export interface ConnectorRepositoryRevalidatorOptions
  extends ConnectorRepositoryRevalidatorEvents {
  refreshIntervalMs?: number | undefined;
  retryIntervalMs?: number | undefined;
}

/**
 * Keeps the cloud authorization proof fresh without blocking connector job
 * polling. Refreshes are single-flight and transient failures retry well before
 * the authorization lease expires.
 */
export class ConnectorRepositoryRevalidator {
  private readonly refreshIntervalMs: number;
  private readonly retryIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<boolean> | undefined;
  private consecutiveFailures = 0;
  private running = false;

  constructor(
    private readonly refreshProof: () => Promise<unknown>,
    private readonly events: Readonly<ConnectorRepositoryRevalidatorOptions> = {},
  ) {
    this.refreshIntervalMs =
      events.refreshIntervalMs ?? REPOSITORY_REVALIDATION_INTERVAL_MS;
    this.retryIntervalMs =
      events.retryIntervalMs ?? REPOSITORY_REVALIDATION_RETRY_MS;
    validateInterval(this.refreshIntervalMs);
    validateInterval(this.retryIntervalMs);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.refreshIntervalMs);
  }

  /** Requests an immediate refresh, for example after transport recovery. */
  refresh(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;

    const refresh = this.runRefresh().finally(() => {
      if (this.inFlight === refresh) this.inFlight = undefined;
    });
    this.inFlight = refresh;
    return refresh;
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async runRefresh(): Promise<boolean> {
    try {
      await this.refreshProof();
      const recoveredAfter = this.consecutiveFailures;
      this.consecutiveFailures = 0;
      if (recoveredAfter > 0) {
        this.events.onRecovered?.({ attempts: recoveredAfter });
      }
      this.schedule(this.refreshIntervalMs);
      return true;
    } catch {
      this.consecutiveFailures += 1;
      this.events.onRetry?.({
        attempt: this.consecutiveFailures,
        delayMs: this.retryIntervalMs,
      });
      this.schedule(this.retryIntervalMs);
      return false;
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delayMs);
    this.timer.unref?.();
  }
}

function validateInterval(value: number): void {
  if (!Number.isInteger(value) || value < 1_000 || value > 86_400_000) {
    throw new Error("Repository revalidation interval is invalid");
  }
}
