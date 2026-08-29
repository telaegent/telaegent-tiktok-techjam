import type { Agent } from "./types.js";

export type AgentProvider = "codex" | "claude";

export type RunPurpose =
  | "sender_draft"
  | "recipient_answer"
  | "plan_intent"
  | "implement"
  | "status"
  | "propose_resolution"
  | "create_context_pack"
  | "publish_dependency_change"
  | "revise_plan";

export type SessionMode = "continue" | "fresh" | "ephemeral";
export type MiddlewareSandboxMode = "read-only" | "workspace-write";
export type NetworkMode = "none" | "default";
export type JsonSchemaDocument = Record<string, unknown>;

export interface MiddlewareRunRequest {
  agentId: string;
  provider: AgentProvider;
  purpose: RunPurpose;
  workspacePath: string;
  runtimePrompt: string;
  persistedSummary: string;
  sessionId?: string | undefined;
  sessionMode: SessionMode;
  sandboxMode: MiddlewareSandboxMode;
  networkMode: NetworkMode;
  outputSchemaName: string;
  correlationId: string;
  maxTurns: number;
}

export interface NormalizedRunResult<T = unknown> {
  provider: AgentProvider;
  sessionId?: string | undefined;
  final: T;
  changedFiles: string[];
  exitCode: number;
  durationMs: number;
}

/**
 * Provider-neutral progress that can be forwarded to a user's private agent
 * room. Deliberately excludes prompts, command arguments, tool output, and
 * model reasoning. Product policy can add richer, explicitly approved events
 * later without coupling the UI to either provider's wire format.
 */
export type RuntimeActivity =
  | "command"
  | "file_change"
  | "mcp"
  | "web_search"
  | "tool";

export type RuntimeProgressEvent =
  | {
      type: "session_started";
      provider: AgentProvider;
    }
  | { type: "turn_started"; provider: AgentProvider }
  | { type: "text_delta"; provider: AgentProvider; text: string }
  | {
      type: "activity_started" | "activity_completed";
      provider: AgentProvider;
      activity: RuntimeActivity;
    }
  | {
      type: "retrying";
      provider: AgentProvider;
      attempt: number;
      maxRetries: number;
      retryDelayMs: number;
    }
  | { type: "turn_failed"; provider: AgentProvider }
  | { type: "turn_completed"; provider: AgentProvider };

export type RuntimeProgressSink = (event: RuntimeProgressEvent) => void;

export type RuntimeCapabilityReason =
  | "not_installed"
  | "not_configured"
  | "not_authenticated"
  | "probe_failed";

export interface RuntimeProviderCapability {
  installed: boolean;
  authenticated: boolean;
  reason: RuntimeCapabilityReason | null;
}

export interface RuntimeProviderProbeRequest {
  agentId: string;
  provider: AgentProvider;
  workspacePath: string;
  correlationId: string;
}

export interface RuntimeProviderProbeResult {
  provider: AgentProvider;
  durationMs: number;
}

export type RuntimeCapabilities = Record<
  AgentProvider,
  RuntimeProviderCapability
>;

export interface MiddlewareProviderRunner {
  readonly provider: AgentProvider;
  runStructured(
    request: MiddlewareRunRequest,
    outputSchema: JsonSchemaDocument,
    onProgress?: RuntimeProgressSink,
  ): Promise<NormalizedRunResult>;
  cancel(agentId: string): Promise<boolean>;
  capability(): Promise<RuntimeProviderCapability>;
}

export interface RuntimeOutputSchemaResolver {
  resolve(outputSchemaName: string): Promise<JsonSchemaDocument>;
}

export interface MiddlewareLifecycleEvent {
  agentId: string;
  runId: string;
  provider: AgentProvider;
  purpose: RunPurpose;
  correlationId: string;
}

export interface MiddlewareLifecycleCallbacks {
  onRunStarted?(event: MiddlewareLifecycleEvent): void | Promise<void>;
  onRunCompleted?(event: MiddlewareLifecycleEvent): void | Promise<void>;
  onRunFailed?(event: MiddlewareLifecycleEvent): void | Promise<void>;
  onRunCancelled?(event: MiddlewareLifecycleEvent): void | Promise<void>;
  onSessionUpdated?(
    event: MiddlewareLifecycleEvent & { sessionId: string },
  ): void | Promise<void>;
  onRuntimeProgress?(
    event: MiddlewareLifecycleEvent & { progress: RuntimeProgressEvent },
  ): void;
}

export interface AgentServiceRuntimeOptions {
  lifecycle?: MiddlewareLifecycleCallbacks | undefined;
  authorizeWorkspace?:
    | ((request: MiddlewareRunRequest, agent: Agent) => boolean | Promise<boolean>)
    | undefined;
}
