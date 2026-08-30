import { RunCancelledError } from "./errors.js";
import type {
  ManagedAgentTurnRequest,
  ManagedAgentTurnResult,
  ProviderSessionManager,
  ProviderSessionScope,
} from "./provider-session-manager.js";
import { RuntimeProviderError } from "./runtime-errors.js";
import {
  RuntimeProgressChannel,
  type RuntimeProgressEnvelope,
  type RuntimeProgressOwner,
  type RuntimeProgressSubscription,
} from "./runtime-progress-channel.js";

export interface StartedPrivateRuntimeTurn<T = unknown> {
  streamId: string;
  completion: Promise<ManagedAgentTurnResult<T>>;
}

export interface PrivateRuntimeTurnCanceller {
  cancelMiddlewareTurn(agentId: string): Promise<boolean>;
}

export interface PrivateRuntimeTurnCoordinatorOptions {
  canceller?: PrivateRuntimeTurnCanceller | undefined;
  terminalRetentionMs?: number | undefined;
  scheduleCleanup?: ((cleanup: () => void, delayMs: number) => void) | undefined;
}

interface TrackedPrivateRuntimeTurn {
  owner: RuntimeProgressOwner;
  agentId: string;
  active: boolean;
}

const defaultTerminalRetentionMs = 60_000;

/**
 * Connects a managed provider session to safe, owner-scoped realtime progress.
 *
 * This is deliberately transport- and persistence-neutral. The eventual HTTP
 * adapter must obtain the scope from an authenticated runtime binding; browser
 * input must never supply a workspace path or claim an owner scope directly.
 */
export class PrivateRuntimeTurnCoordinator {
  private readonly turns = new Map<string, TrackedPrivateRuntimeTurn>();
  private readonly terminalRetentionMs: number;
  private readonly scheduleCleanup: (cleanup: () => void, delayMs: number) => void;

  constructor(
    private readonly sessions: ProviderSessionManager,
    private readonly progress: RuntimeProgressChannel = new RuntimeProgressChannel(),
    private readonly options: PrivateRuntimeTurnCoordinatorOptions = {},
  ) {
    this.terminalRetentionMs = options.terminalRetentionMs ?? defaultTerminalRetentionMs;
    if (
      !Number.isInteger(this.terminalRetentionMs) ||
      this.terminalRetentionMs < 0 ||
      this.terminalRetentionMs > 3_600_000
    ) {
      throw new Error("Private runtime terminal retention is invalid");
    }
    this.scheduleCleanup = options.scheduleCleanup ?? scheduleCleanup;
  }

  start<T = unknown>(
    scope: ProviderSessionScope,
    request: ManagedAgentTurnRequest,
    beforeExecution?: () => void | Promise<void>,
  ): StartedPrivateRuntimeTurn<T> {
    const owner = progressOwner(scope);
    const streamId = this.progress.open(owner);
    this.turns.set(streamId, {
      owner,
      agentId: request.agentId,
      active: false,
    });
    const completion = this.sessions
      .run<T>(
        scope,
        request,
        (event) => {
          this.progress.publish(streamId, event);
        },
        () => {
          const tracked = this.turns.get(streamId);
          if (tracked) tracked.active = true;
        },
        beforeExecution,
      )
      .catch((error: unknown) => {
        this.progress.publish(streamId, {
          type: terminalFailureEvent(error),
          provider: scope.provider,
        });
        throw error;
      })
      .finally(() => {
        const tracked = this.turns.get(streamId);
        if (tracked) tracked.active = false;
        this.scheduleCleanup(() => {
          this.progress.close(streamId, owner);
          this.turns.delete(streamId);
        }, this.terminalRetentionMs);
      });
    return { streamId, completion };
  }

  async cancel(streamId: string, owner: RuntimeProgressOwner): Promise<boolean> {
    const tracked = this.turns.get(streamId);
    if (
      !tracked ||
      !tracked.active ||
      !sameOwner(tracked.owner, owner) ||
      !this.options.canceller
    ) {
      return false;
    }
    return this.options.canceller.cancelMiddlewareTurn(tracked.agentId);
  }

  subscribe(
    streamId: string,
    owner: RuntimeProgressOwner,
    listener: (event: RuntimeProgressEnvelope) => void,
  ): RuntimeProgressSubscription | null {
    return this.progress.subscribe(streamId, owner, listener);
  }

  close(streamId: string, owner: RuntimeProgressOwner): boolean {
    const closed = this.progress.close(streamId, owner);
    if (closed) this.turns.delete(streamId);
    return closed;
  }
}

function terminalFailureEvent(
  error: unknown,
): "turn_cancelled" | "turn_timed_out" | "turn_failed" {
  if (error instanceof RunCancelledError) return "turn_cancelled";
  if (
    error instanceof RuntimeProviderError &&
    error.code === "RUNTIME_TIMEOUT"
  ) {
    return "turn_timed_out";
  }
  return "turn_failed";
}

function scheduleCleanup(cleanup: () => void, delayMs: number): void {
  const timeout = setTimeout(cleanup, delayMs);
  timeout.unref();
}

function progressOwner(scope: ProviderSessionScope): RuntimeProgressOwner {
  return {
    userId: scope.userId,
    repositoryId: scope.repositoryId,
    conversationId: scope.conversationId,
  };
}

function sameOwner(
  left: RuntimeProgressOwner,
  right: RuntimeProgressOwner,
): boolean {
  return (
    left.userId === right.userId &&
    left.repositoryId === right.repositoryId &&
    left.conversationId === right.conversationId
  );
}
