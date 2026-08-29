import type { TelaegentDatabase } from "./telaegent/types.js";

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
export type AgentProvider = "codex" | "claude";
export type RunPurpose =
  | "plan_intent"
  | "implement"
  | "status"
  | "propose_resolution"
  | "create_context_pack"
  | "publish_dependency_change"
  | "revise_plan";
export type SessionMode = "continue" | "fresh" | "ephemeral";
export type SandboxMode = "read-only" | "workspace-write";
export type NetworkMode = "none" | "default";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  /** Optional only while old version-1 files are being backfilled by JsonStore. */
  telaegent?: TelaegentDatabase | undefined;
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

/** Provider-neutral request used by Telaegent middleware runs. */
export interface MiddlewareRunRequest {
  agentId: string;
  provider: AgentProvider;
  purpose: RunPurpose;
  workspacePath: string;
  runtimePrompt: string;
  persistedSummary: string;
  sessionId?: string | undefined;
  sessionMode: SessionMode;
  sandboxMode: SandboxMode;
  networkMode: NetworkMode;
  outputSchemaName: string;
  correlationId: string;
  maxTurns: number;
}

/** Safe, normalized result returned after provider output validation. */
export interface NormalizedRunResult<T> {
  provider: AgentProvider;
  sessionId?: string | undefined;
  final: T;
  changedFiles: string[];
  exitCode: number;
  durationMs: number;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
