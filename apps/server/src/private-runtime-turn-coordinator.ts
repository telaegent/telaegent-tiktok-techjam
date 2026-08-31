import { randomUUID } from "node:crypto";
import type {
  ManagedAgentTurnRequest,
  ManagedAgentTurnResult,
  ProviderSessionScope,
} from "./provider-session-manager.js";
import type {
  RuntimeAllowedAction,
  RuntimeProgressEvent,
  RuntimeProgressFailure,
} from "./runtime-contract.js";
import { normalizeRuntimeFailure } from "./runtime-errors.js";
import {
  RuntimeProgressChannel,
  type RuntimeProgressEnvelope,
  type RuntimeProgressOwner,
  type RuntimeProgressSubscription,
} from "./runtime-progress-channel.js";

export interface StartedPrivateRuntimeTurn<T = unknown> {
  turnId: string;
  streamId: string;
  initialState: "queued";
  completion: Promise<ManagedAgentTurnResult<T>>;
}

export type PrivateRuntimeTurnState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface PrivateRuntimeTurnStatus {
  turnId: string;
  streamId: string;
  state: PrivateRuntimeTurnState;
  failure?: RuntimeProgressFailure | undefined;
  allowedActions: RuntimeAllowedAction[];
}

export interface PrivateRuntimeTurnCanceller {
  cancelMiddlewareTurn(agentId: string): Promise<boolean>;
}

/**
 * Execution seam used by the cloud coordinator. The canonical implementation
 * dispatches to an outbound local connector; ProviderSessionManager remains a
 * connector-side/local adapter for tests and live CLI experiments.
 */
export interface PrivateTurnExecutor {
  run<T = unknown>(
    scope: ProviderSessionScope,
    request: ManagedAgentTurnRequest,
    onProgress?: (event: RuntimeProgressEvent) => void,
    onExecutionStarted?: () => void,
    beforeExecution?: () => void | Promise<void>,
  ): Promise<ManagedAgentTurnResult<T>>;
}

export interface PrivateRuntimeTurnCoordinatorOptions {
  canceller?: PrivateRuntimeTurnCanceller | undefined;
  terminalRetentionMs?: number | undefined;
  scheduleCleanup?: ((cleanup: () => void, delayMs: number) => void) | undefined;
}

interface TrackedPrivateRuntimeTurn {
  turnId: string;
  streamId: string;
  owner: RuntimeProgressOwner;
  agentId: string;
  state: PrivateRuntimeTurnState;
  failure?: RuntimeProgressFailure | undefined;
  allowedActions: RuntimeAllowedAction[];
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
  private readonly turnIdsByStream = new Map<string, string>();
  private readonly terminalRetentionMs: number;
  private readonly scheduleCleanup: (cleanup: () => void, delayMs: number) => void;

  constructor(
    private readonly sessions: PrivateTurnExecutor,
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
    const turnId = randomUUID();
    const streamId = this.progress.open(owner);
    this.turns.set(turnId, {
      turnId,
      streamId,
      owner,
      agentId: request.agentId,
      state: "queued",
      allowedActions: [],
    });
    this.turnIdsByStream.set(streamId, turnId);
    const completion = this.sessions
      .run<T>(
        scope,
        request,
        (event) => {
          if (isTerminalProgress(event)) return;
          this.progress.publish(streamId, event);
        },
        () => {
          const tracked = this.turns.get(turnId);
          if (tracked) tracked.state = "running";
        },
        beforeExecution,
      )
      .then((result) => {
        const tracked = this.turns.get(turnId);
        if (tracked) tracked.state = "completed";
        this.progress.publish(streamId, {
          type: "turn_completed",
          provider: scope.provider,
        });
        return result;
      })
      .catch((error: unknown) => {
        const event = terminalFailureEvent(error, scope.provider);
        const tracked = this.turns.get(turnId);
        if (tracked) {
          tracked.state = terminalState(event.type);
          tracked.failure = event.failure;
          tracked.allowedActions = event.allowedActions;
        }
        this.progress.publish(streamId, event);
        throw error;
      })
      .finally(() => {
        this.scheduleCleanup(() => {
          this.progress.close(streamId, owner);
          this.turnIdsByStream.delete(streamId);
          this.turns.delete(turnId);
        }, this.terminalRetentionMs);
      });
    return { turnId, streamId, initialState: "queued", completion };
  }

  status(
    turnId: string,
    owner: RuntimeProgressOwner,
  ): PrivateRuntimeTurnStatus | null {
    const tracked = this.turns.get(turnId);
    if (!tracked || !sameOwner(tracked.owner, owner)) return null;
    return {
      turnId: tracked.turnId,
      streamId: tracked.streamId,
      state: tracked.state,
      failure: tracked.failure ? structuredClone(tracked.failure) : undefined,
      allowedActions: [...tracked.allowedActions],
    };
  }

  async cancel(turnId: string, owner: RuntimeProgressOwner): Promise<boolean> {
    const tracked = this.turns.get(turnId);
    if (
      !tracked ||
      tracked.state !== "running" ||
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
    if (closed) {
      const turnId = this.turnIdsByStream.get(streamId);
      this.turnIdsByStream.delete(streamId);
      if (turnId) this.turns.delete(turnId);
    }
    return closed;
  }
}

function isTerminalProgress(event: RuntimeProgressEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_timed_out" ||
    event.type === "turn_cancelled"
  );
}

function terminalFailureEvent(
  error: unknown,
  provider: ProviderSessionScope["provider"],
): Extract<
  RuntimeProgressEvent,
  { type: "turn_cancelled" | "turn_timed_out" | "turn_failed" }
> {
  const normalized = normalizeRuntimeFailure(error);
  const failure: RuntimeProgressFailure = {
    code: normalized.code,
    error: normalized.message,
    retryable: normalized.retryable,
  };
  const type =
    normalized.code === "RUNTIME_CANCELLED"
      ? "turn_cancelled"
      : normalized.code === "RUNTIME_TIMEOUT"
        ? "turn_timed_out"
        : "turn_failed";
  return {
    type,
    provider,
    failure,
    allowedActions: allowedActions(normalized.code),
  };
}

function terminalState(
  type: "turn_cancelled" | "turn_timed_out" | "turn_failed",
): PrivateRuntimeTurnState {
  if (type === "turn_cancelled") return "cancelled";
  if (type === "turn_timed_out") return "timed_out";
  return "failed";
}

function allowedActions(
  code: RuntimeProgressFailure["code"],
): RuntimeAllowedAction[] {
  switch (code) {
    case "RUNTIME_AUTHENTICATION_FAILED":
      return ["reconnect_provider", "dismiss"];
    case "RUNTIME_TIMEOUT":
    case "INVALID_AGENT_OUTPUT":
      return ["retry", "edit_request", "dismiss"];
    case "RUNTIME_OUTPUT_LIMIT":
    case "UNSUPPORTED_RUNTIME_POLICY":
      return ["edit_request", "dismiss"];
    case "RUNTIME_CANCELLED":
      return ["dismiss"];
    default:
      return ["retry", "dismiss"];
  }
}

function scheduleCleanup(cleanup: () => void, delayMs: number): void {
  const timeout = setTimeout(cleanup, delayMs);
  timeout.unref();
}

function progressOwner(scope: ProviderSessionScope): RuntimeProgressOwner {
  return {
    userId: scope.userId,
    githubRepositoryId: scope.githubRepositoryId,
    conversationId: scope.conversationId,
  };
}

function sameOwner(
  left: RuntimeProgressOwner,
  right: RuntimeProgressOwner,
): boolean {
  return (
    left.userId === right.userId &&
    left.githubRepositoryId === right.githubRepositoryId &&
    left.conversationId === right.conversationId
  );
}
