export interface AdaptivePollerOptions {
  poll: () => Promise<boolean>;
  minimumDelayMs?: number;
  maximumDelayMs?: number;
  onError?: (error: unknown) => void;
}

export class AdaptivePoller {
  private readonly minimumDelayMs: number;
  private readonly maximumDelayMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private paused = false;
  private running = false;
  private refreshPending = false;
  private idleRounds = 0;

  constructor(private readonly options: AdaptivePollerOptions) {
    this.minimumDelayMs = options.minimumDelayMs ?? 3_000;
    this.maximumDelayMs = options.maximumDelayMs ?? 30_000;
    if (this.minimumDelayMs <= 0 || this.maximumDelayMs < this.minimumDelayMs) {
      throw new Error("Adaptive polling delays are invalid");
    }
  }

  start(immediate = true): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (this.paused) return;
    if (immediate) this.refresh();
    else this.schedule(this.minimumDelayMs);
  }

  refresh(): void {
    if (!this.started || this.stopped || this.paused) return;
    this.clearTimer();
    if (this.running) {
      this.refreshPending = true;
      return;
    }
    void this.run();
  }

  setPaused(paused: boolean): void {
    if (this.stopped || this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.refreshPending = false;
      this.clearTimer();
      return;
    }
    if (this.started) this.refresh();
  }

  stop(): void {
    this.stopped = true;
    this.refreshPending = false;
    this.clearTimer();
  }

  private async run(): Promise<void> {
    if (this.running || this.paused || this.stopped) return;
    this.running = true;
    try {
      const hasActivity = await this.options.poll();
      this.idleRounds = hasActivity ? 0 : Math.min(this.idleRounds + 1, 30);
    } catch (error) {
      this.idleRounds = Math.min(this.idleRounds + 1, 30);
      this.options.onError?.(error);
    } finally {
      this.running = false;
    }
    if (this.stopped || this.paused) return;
    if (this.refreshPending) {
      this.refreshPending = false;
      this.refresh();
      return;
    }
    const multiplier = 2 ** Math.min(this.idleRounds, 10);
    this.schedule(Math.min(this.maximumDelayMs, this.minimumDelayMs * multiplier));
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

export class SingleFlightByKey<T> {
  private readonly requests = new Map<string, Promise<T>>();

  run(key: string, request: () => Promise<T>): Promise<T> {
    const current = this.requests.get(key);
    if (current) return current;
    const next = request().finally(() => {
      if (this.requests.get(key) === next) this.requests.delete(key);
    });
    this.requests.set(key, next);
    return next;
  }

  async runFresh(key: string, request: () => Promise<T>): Promise<T> {
    const current = this.requests.get(key);
    if (current) {
      try {
        await current;
      } catch {
        // A requested refresh must still get a new attempt after a failed flight.
      }
    }
    return this.run(key, request);
  }
}
