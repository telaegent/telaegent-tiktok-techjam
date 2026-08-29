export type RuntimeTimeoutKind = "idle" | "maximum";

/**
 * Enforces both progress inactivity and total wall-clock limits for one CLI
 * process. Provider output should call `activity`; `stop` must run when the
 * child settles so timers never outlive the turn.
 */
export class RuntimeWatchdog {
  private idleTimer: NodeJS.Timeout | null = null;
  private maximumTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly idleTimeoutMs: number,
    maximumTimeoutMs: number,
    private readonly onTimeout: (kind: RuntimeTimeoutKind) => void,
  ) {
    validateTimeout(idleTimeoutMs);
    validateTimeout(maximumTimeoutMs);
    this.maximumTimer = armTimer(
      () => this.timeout("maximum"),
      maximumTimeoutMs,
    );
    this.resetIdleTimer();
  }

  activity(): void {
    if (this.stopped) return;
    this.resetIdleTimer();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.maximumTimer) clearTimeout(this.maximumTimer);
    this.idleTimer = null;
    this.maximumTimer = null;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = armTimer(
      () => this.timeout("idle"),
      this.idleTimeoutMs,
    );
  }

  private timeout(kind: RuntimeTimeoutKind): void {
    if (this.stopped) return;
    this.stop();
    this.onTimeout(kind);
  }
}

function armTimer(callback: () => void, delayMs: number): NodeJS.Timeout {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return timer;
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error("Runtime timeout is invalid");
  }
}
