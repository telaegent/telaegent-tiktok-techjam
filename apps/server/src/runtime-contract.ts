import type { ConnectorResourceRequest } from "./connectors/resource-exchange.js";
import type { RuntimeEffort } from "./runtime-efforts.js";
import type { Agent } from "./types.js";

export type AgentProvider = "codex" | "claude";

export type RuntimeErrorCode =
  | "RUNTIME_UNAVAILABLE"
  | "RUNTIME_AUTHENTICATION_FAILED"
  | "RUNTIME_SESSION_NOT_FOUND"
  | "RUNTIME_TIMEOUT"
  | "RUNTIME_OUTPUT_LIMIT"
  | "INVALID_AGENT_OUTPUT"
  | "UNSUPPORTED_RUNTIME_POLICY"
  | "RUNTIME_FAILED";

export type PublicRuntimeErrorCode = RuntimeErrorCode | "RUNTIME_CANCELLED";

export type RunPurpose =
  | "sender_draft"
  | "recipient_answer"
  | "clarification_dialogue"
  | "plan_intent"
  | "implement"
  | "status"
  | "propose_resolution"
  | "create_context_pack"
  | "publish_dependency_change"
  | "revise_plan";

export type SessionMode = "continue" | "fresh" | "ephemeral";
export type ProviderSessionLane = "private_work" | "clarification_dialogue";
export type MiddlewareSandboxMode = "read-only" | "workspace-write";
export type NetworkMode = "none" | "default";
export type JsonSchemaDocument = Record<string, unknown>;

export interface MiddlewareRunRequest {
  agentId: string;
  /** Opaque cloud binding. A local connector resolves this to its registered workspace. */
  connectorBindingId?: string | undefined;
  provider: AgentProvider;
  purpose: RunPurpose;
  /** Local-adapter field only. It is forbidden in cloud connector jobs/state. */
  workspacePath?: string | undefined;
  runtimePrompt: string;
  persistedSummary: string;
  sessionId?: string | undefined;
  sessionMode: SessionMode;
  sandboxMode: MiddlewareSandboxMode;
  networkMode: NetworkMode;
  outputSchemaName: string;
  correlationId: string;
  maxTurns: number;
  /**
   * Whether this pass may read the workspace at all.
   *
   * A drafting pass writes its answer from evidence it was handed; giving it
   * file tools it does not need is what turns a missing research note into a
   * failed turn, because it spends its whole turn budget reading and never
   * returns structured output. `none` removes the temptation structurally.
   *
   * Honoured by the Claude runner. Codex has no equivalent: its built-in tool
   * surface cannot be closed without `--disable`, which `closedToolSurface`
   * documents as unsafe across releases. Like `maxTurns`, this is a bound the
   * two runners do not share -- safe, because the sandbox is read-only and the
   * workspace is pinned either way, but do not read it as symmetry.
   */
  toolMode?: "none" | "read" | undefined;

  /**
   * How much reasoning the provider should spend before answering.
   *
   * Unset means `DEFAULT_RUNTIME_EFFORT`, not "whatever the CLI does", and it
   * means it on both providers: the Claude runner defaults `--effort` to that
   * constant and `closedToolSurface()` writes the same one into Codex's
   * `model_reasoning_effort`. Set this field only to depart from it.
   *
   * Left to the Claude CLI's own default it reasons at its maximum, which is
   * the right setting for a pass that has to work something out and the wrong
   * one for a pass that is transcribing a decision already made. Measured on
   * the drafting pass, whose evidence arrives pre-gathered in the note: the same
   * prompt, note and schema took 38.6s unset and 23.0s at "medium", and the
   * thinking is what went -- 1123 thinking tokens down to 153, first character
   * of the answer at 21.1s down to 5.5s, and the same answer at the end of it
   * (4147 characters against 4131).
   *
   * It does not scale past that, because it governs only the thinking. Of the
   * 23 seconds at "medium", 17.6 are spent emitting the object itself. Setting
   * this lower buys less than it looks like it should, and "low" buys part of
   * its remaining speed by writing a shorter answer -- 2425 characters on the
   * same prompt. Reach for the schema's maxLength before reaching for "low".
   *
   * Both runners honour it, but by unrelated routes: Claude takes `--effort`,
   * while Codex has no flag for it and receives it as a `-c` config override
   * that `--ignore-user-config` would otherwise blank to `none`. The rungs are
   * therefore only as shared as `RUNTIME_EFFORTS` says they are -- each CLI
   * accepts values the other does not, and on Codex the set narrows again per
   * model. Allowlist first; neither CLI falls back on a value it dislikes.
   */
  effort?: RuntimeEffort | undefined;

  /**
   * Which model of the chosen provider should answer.
   *
   * The one runtime field a product surface picks. Everything else here is
   * decided by the server, so this is the only value in the request that
   * originates with a caller -- which is why it is allowlisted at the
   * authorization seam rather than passed through (see `runtime-models.ts`).
   *
   * Absent means "do not say", not "use the default": the runners omit
   * `--model` entirely, leaving whatever the deployment configured
   * (`CLAUDE_MODEL` / `CODEX_MODEL`) or the CLI's own default in charge. That
   * is what makes adding this field a no-op for every existing caller.
   *
   * Honoured by both runners, unlike `toolMode` and `effort`. It is the first
   * knob in this contract the two providers actually share.
   */
  model?: string | undefined;
}

/**
 * Connector-side request after an opaque binding has been resolved locally.
 * This type must never be serialized as a cloud job because it contains a
 * developer-machine path.
 */
export type LocalMiddlewareRunRequest = MiddlewareRunRequest & {
  workspacePath: string;
};

export interface NormalizedRunResult<T = unknown> {
  provider: AgentProvider;
  sessionId?: string | undefined;
  final: T;
  changedFiles: string[];
  exitCode: number;
  durationMs: number;
  /**
   * Files this turn asked a peer for (build plan 8.3).
   *
   * Absent on an ordinary turn, and never a claim to anything: a request names
   * either an identifier the owner's machine already minted or a hint for the
   * owning human to read. Both are answered on the other machine, by that
   * person, and neither authorizes a read here.
   */
  resourceRequests?: readonly ConnectorResourceRequest[] | undefined;
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

export type RuntimeAllowedAction =
  | "retry"
  | "reconnect_provider"
  | "edit_request"
  | "dismiss";

export interface RuntimeProgressFailure {
  code: PublicRuntimeErrorCode;
  error: string;
  retryable: boolean;
}

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
      /**
       * Workspace-relative name of what the activity touched, or absent.
       *
       * The connector computes this through `projectRelativeDisplayLabel` and
       * omits it for anything outside the workspace. It is the only local
       * detail permitted to cross; prompts, command arguments, tool output,
       * and model reasoning remain excluded.
       */
      target?: string;
    }
  | {
      type: "retrying";
      provider: AgentProvider;
      attempt: number;
      maxRetries: number;
      retryDelayMs: number;
    }
  | {
      type: "turn_cancelled" | "turn_timed_out" | "turn_failed";
      provider: AgentProvider;
      failure: RuntimeProgressFailure;
      allowedActions: RuntimeAllowedAction[];
    }
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
    request: LocalMiddlewareRunRequest,
    outputSchema: JsonSchemaDocument,
    onProgress?: RuntimeProgressSink,
    signal?: AbortSignal,
  ): Promise<NormalizedRunResult>;
  cancel(agentId: string): Promise<boolean>;
  /**
   * Stops every run this runner owns, for shutdown.
   *
   * Optional: a runner whose children are not detached from this process's
   * group already receives the terminal's signal and needs nothing here.
   */
  cancelAll?(): Promise<void>;
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
