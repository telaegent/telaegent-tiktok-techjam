import { randomUUID } from "node:crypto";
import type {
  ManagedAgentTurnRequest,
  ManagedAgentTurnResult,
  ProviderSessionScope,
} from "../provider-session-manager.js";
import type { PrivateTurnExecutor } from "../private-runtime-turn-coordinator.js";
import type {
  AgentProvider,
  MiddlewareSandboxMode,
  NetworkMode,
  RunPurpose,
  RuntimeProgressSink,
  SessionMode,
} from "../runtime-contract.js";
import { RuntimeProviderError } from "../runtime-errors.js";
import type { ConnectorResourceRequest } from "./resource-exchange.js";

/**
 * Maximum wall-clock time reserved for the connector-local research pass.
 *
 * This is part of the job-budget contract, not merely a runner detail: the
 * cloud lease must cover this pass and the drafting pass that follows it.
 */
export const CONNECTOR_INVESTIGATION_DEADLINE_MS = 90_000;

/** Time reserved for returning the bounded result after local execution. */
export const CONNECTOR_JOB_COMPLETION_GRACE_MS = 30_000;

export function connectorJobTimeoutMs(maximumProviderTimeoutMs: number): number {
  if (!Number.isInteger(maximumProviderTimeoutMs) || maximumProviderTimeoutMs < 1_000) {
    throw new Error("Connector provider timeout is invalid");
  }
  return (
    CONNECTOR_INVESTIGATION_DEADLINE_MS +
    maximumProviderTimeoutMs +
    CONNECTOR_JOB_COMPLETION_GRACE_MS
  );
}

export interface ConnectorJobRequest {
  jobId: string;
  connectorBindingId: string;
  userId: string;
  githubRepositoryId: string;
  conversationId: string;
  provider: AgentProvider;
  purpose: RunPurpose;
  runtimePrompt: string;
  persistedSummary: string;
  sessionMode: SessionMode;
  /**
   * Authorized execution policy. The cloud decides it; the connector must
   * enforce it locally and reject a job it cannot honour.
   */
  sandboxMode: MiddlewareSandboxMode;
  networkMode: NetworkMode;
  outputSchemaName: string;
  correlationId: string;
  maxTurns: number;
}

/** Result returned by a local connector after it validates and runs a job. */
export interface ConnectorJobResult<T = unknown> {
  provider: AgentProvider;
  final: T;
  changedFiles: string[];
  exitCode: number;
  durationMs: number;
  /**
   * Resources this turn asked a peer for (build plan 8.3).
   *
   * Absent on an ordinary turn. Present entries are routed by the cloud to the
   * owning connector; they never authorize anything by themselves.
   */
  resourceRequests?: readonly ConnectorResourceRequest[] | undefined;
}

export interface ConnectorJobRelay {
  dispatch<T = unknown>(
    job: Readonly<ConnectorJobRequest>,
    onProgress?: RuntimeProgressSink,
  ): Promise<ConnectorJobResult<T>>;
  cancel(connectorBindingId: string): Promise<boolean>;
}

export interface ConnectorTurnExecutorOptions {
  createJobId?: () => string;
}

const bindingPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/**
 * Converts an authorized cloud turn into a path-free connector job.
 *
 * Provider session references are intentionally absent. A connector owns its
 * local session cache and interprets `sessionMode` within the supplied product
 * scope. The cloud relay never sees a provider session ID.
 */
export class ConnectorTurnExecutor
  implements PrivateTurnExecutor
{
  constructor(
    private readonly relay: ConnectorJobRelay,
    private readonly options: ConnectorTurnExecutorOptions = {},
  ) {}

  async run<T = unknown>(
    scope: ProviderSessionScope,
    request: ManagedAgentTurnRequest,
    onProgress?: RuntimeProgressSink,
    onExecutionStarted?: () => void,
    beforeExecution?: () => void | Promise<void>,
  ): Promise<ManagedAgentTurnResult<T>> {
    const bindingId = request.connectorBindingId;
    if (
      !bindingId ||
      !bindingPattern.test(bindingId) ||
      request.workspacePath !== undefined ||
      request.agentId !== bindingId
    ) {
      throw new RuntimeProviderError(
        "UNSUPPORTED_RUNTIME_POLICY",
        "Connector job binding is invalid",
      );
    }

    await beforeExecution?.();
    onExecutionStarted?.();
    const result = await this.relay.dispatch<T>(
      {
        jobId: this.options.createJobId?.() ?? randomUUID(),
        connectorBindingId: bindingId,
        userId: scope.userId,
        githubRepositoryId: scope.githubRepositoryId,
        conversationId: scope.conversationId,
        provider: scope.provider,
        purpose: request.purpose,
        runtimePrompt: request.runtimePrompt,
        persistedSummary: request.persistedSummary,
        sessionMode: request.sessionMode ?? "continue",
        sandboxMode: request.sandboxMode,
        networkMode: request.networkMode,
        outputSchemaName: request.outputSchemaName,
        correlationId: request.correlationId,
        maxTurns: request.maxTurns,
      },
      onProgress,
    );
    return result;
  }

  cancelMiddlewareTurn(connectorBindingId: string): Promise<boolean> {
    return this.relay.cancel(connectorBindingId);
  }
}
