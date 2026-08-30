import type {
  AgentProvider,
  MiddlewareRunRequest,
  NormalizedRunResult,
  RuntimeProgressSink,
} from "./runtime-contract.js";
import { RuntimeProviderError } from "./runtime-errors.js";

export interface ProviderSessionScope {
  userId: string;
  githubRepositoryId: number;
  conversationId: string;
  provider: AgentProvider;
}

export interface ProviderSessionRecord extends ProviderSessionScope {
  sessionId: string;
  updatedAt: string;
}

export interface ProviderSessionStore {
  get(scope: ProviderSessionScope): Promise<ProviderSessionRecord | null>;
  set(record: ProviderSessionRecord): Promise<void>;
  delete(scope: ProviderSessionScope): Promise<void>;
}

export interface ProviderSessionRuntime {
  run(
    request: MiddlewareRunRequest,
    onProgress?: RuntimeProgressSink,
  ): Promise<NormalizedRunResult>;
}

export type ManagedAgentTurnRequest = Omit<
  MiddlewareRunRequest,
  "provider" | "sessionId" | "sessionMode"
> & {
  sessionMode?: "continue" | "fresh" | "ephemeral";
};

export type ManagedAgentTurnResult<T = unknown> = Omit<
  NormalizedRunResult<T>,
  "sessionId"
>;

export type ProviderSessionHydrator = (
  scope: ProviderSessionScope,
  request: ManagedAgentTurnRequest,
) => Promise<ManagedAgentTurnRequest>;

const validScopePart = /^[^\u0000\r\n]{1,256}$/;
const validSessionId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/**
 * Owns provider session references behind Telaegent's product scope.
 *
 * Provider sessions are an optimization only. Callers provide canonical
 * Telaegent conversation context through `rehydrate`; a missing provider
 * session is deleted and recreated once from that durable context.
 */
export class ProviderSessionManager {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly runtime: ProviderSessionRuntime,
    private readonly sessions: ProviderSessionStore,
    private readonly rehydrate: ProviderSessionHydrator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run<T = unknown>(
    scope: ProviderSessionScope,
    request: ManagedAgentTurnRequest,
    onProgress?: RuntimeProgressSink,
    onExecutionStarted?: () => void,
    beforeExecution?: () => void | Promise<void>,
  ): Promise<ManagedAgentTurnResult<T>> {
    this.validateScope(scope);
    const key = sessionKey(scope);
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.queues.set(key, queued);

    await previous;
    try {
      // Authorization-sensitive callers use this after queueing so revocation
      // cannot take effect while a turn waits and still permit execution.
      await beforeExecution?.();
      try {
        onExecutionStarted?.();
      } catch {
        // Realtime coordination is best-effort and cannot fail a provider turn.
      }
      return await this.runExclusive<T>(scope, request, onProgress);
    } finally {
      release();
      if (this.queues.get(key) === queued) this.queues.delete(key);
    }
  }

  /**
   * Removes a private provider cache entry after a disconnect, credential
   * change, runtime replacement, repository revocation, or conversation
   * deletion. Invalidation is serialized with turns in the same scope.
   */
  async invalidate(scope: ProviderSessionScope): Promise<void> {
    this.validateScope(scope);
    const key = sessionKey(scope);
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.queues.set(key, queued);

    await previous;
    try {
      await this.sessions.delete(scope);
    } finally {
      release();
      if (this.queues.get(key) === queued) this.queues.delete(key);
    }
  }

  private async runExclusive<T>(
    scope: ProviderSessionScope,
    request: ManagedAgentTurnRequest,
    onProgress?: RuntimeProgressSink,
  ): Promise<ManagedAgentTurnResult<T>> {
    const requestedMode = request.sessionMode ?? "continue";
    if (requestedMode === "ephemeral") {
      const result = (await this.runtime.run(
        this.runtimeRequest(scope, request, "ephemeral"),
        onProgress,
      )) as NormalizedRunResult<T>;
      return publicResult(result);
    }

    if (requestedMode === "fresh") {
      await this.sessions.delete(scope);
      return await this.startFresh<T>(scope, request, onProgress, false);
    }

    const existing = await this.sessions.get(scope);
    if (!existing) {
      return await this.startFresh<T>(scope, request, onProgress, true);
    }
    if (!validSessionId.test(existing.sessionId)) {
      await this.sessions.delete(scope);
      return await this.startFresh<T>(scope, request, onProgress, true);
    }

    try {
      const result = (await this.runtime.run(
        this.runtimeRequest(scope, request, "continue", existing.sessionId),
        onProgress,
      )) as NormalizedRunResult<T>;
      await this.rememberResult(scope, result, existing.sessionId);
      return publicResult(result);
    } catch (error) {
      if (
        !(error instanceof RuntimeProviderError) ||
        error.code !== "RUNTIME_SESSION_NOT_FOUND"
      ) {
        throw error;
      }
      await this.sessions.delete(scope);
      return await this.startFresh<T>(scope, request, onProgress, true);
    }
  }

  private async startFresh<T>(
    scope: ProviderSessionScope,
    request: ManagedAgentTurnRequest,
    onProgress: RuntimeProgressSink | undefined,
    needsHydration: boolean,
  ): Promise<ManagedAgentTurnResult<T>> {
    const hydrated = needsHydration
      ? await this.rehydrate(scope, request)
      : request;
    const result = (await this.runtime.run(
      this.runtimeRequest(scope, hydrated, "fresh"),
      onProgress,
    )) as NormalizedRunResult<T>;
    await this.rememberResult(scope, result);
    return publicResult(result);
  }

  private async rememberResult(
    scope: ProviderSessionScope,
    result: NormalizedRunResult,
    fallbackSessionId?: string,
  ): Promise<void> {
    const sessionId = result.sessionId ?? fallbackSessionId;
    if (!sessionId) {
      await this.sessions.delete(scope);
      return;
    }
    if (!validSessionId.test(sessionId)) {
      await this.sessions.delete(scope);
      throw new RuntimeProviderError(
        "INVALID_AGENT_OUTPUT",
        "Agent provider returned an invalid session ID",
      );
    }
    await this.sessions.set({
      ...scope,
      sessionId,
      updatedAt: this.now().toISOString(),
    });
  }

  private runtimeRequest(
    scope: ProviderSessionScope,
    request: ManagedAgentTurnRequest,
    sessionMode: MiddlewareRunRequest["sessionMode"],
    sessionId?: string,
  ): MiddlewareRunRequest {
    const { sessionMode: _ignored, ...turn } = request;
    return {
      ...turn,
      provider: scope.provider,
      sessionMode,
      ...(sessionId ? { sessionId } : {}),
    };
  }

  private validateScope(scope: ProviderSessionScope): void {
    for (const value of [scope.userId, scope.conversationId]) {
      if (!validScopePart.test(value)) {
        throw new Error("Provider session scope is invalid");
      }
    }
    if (
      !Number.isSafeInteger(scope.githubRepositoryId) ||
      scope.githubRepositoryId <= 0
    ) {
      throw new Error("Provider session scope is invalid");
    }
  }
}

export class InMemoryProviderSessionStore implements ProviderSessionStore {
  private readonly records = new Map<string, ProviderSessionRecord>();

  async get(scope: ProviderSessionScope): Promise<ProviderSessionRecord | null> {
    const record = this.records.get(sessionKey(scope));
    return record ? structuredClone(record) : null;
  }

  async set(record: ProviderSessionRecord): Promise<void> {
    this.records.set(sessionKey(record), structuredClone(record));
  }

  async delete(scope: ProviderSessionScope): Promise<void> {
    this.records.delete(sessionKey(scope));
  }
}

function sessionKey(scope: ProviderSessionScope): string {
  return [
    scope.userId,
    scope.githubRepositoryId,
    scope.conversationId,
    scope.provider,
  ].join("\u0000");
}

function publicResult<T>(
  result: NormalizedRunResult<T>,
): ManagedAgentTurnResult<T> {
  const { sessionId: _privateSessionId, ...safe } = result;
  return safe;
}
