import type {
  PrivateRuntimeTurnCoordinator,
  StartedPrivateRuntimeTurn,
} from "../private-runtime-turn-coordinator.js";
import type {
  ManagedAgentTurnRequest,
  ProviderSessionScope,
} from "../provider-session-manager.js";
import type {
  AgentProvider,
  RunPurpose,
  SessionMode,
} from "../runtime-contract.js";
import { isSupportedEffort, type RuntimeEffort } from "../runtime-efforts.js";
import { isSupportedModel } from "../runtime-models.js";
import {
  PrivateRuntimeAuthorizationError,
  type PrivateRuntimeAuthorizer,
} from "./private-runtime-authorization.js";
import type {
  AuthorizedPrivateRuntime,
  AuthorizePrivateRuntimeInput,
} from "./types.js";

const outputSchemaNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.schema\.json$/;
const correlationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const privateTurnPurposes = new Set<RunPurpose>([
  "sender_draft",
  "recipient_answer",
  "clarification_dialogue",
]);
const sessionModes = new Set<SessionMode>(["continue", "fresh", "ephemeral"]);
const providers = new Set<AgentProvider>(["codex", "claude"]);

export type PrivateConversationTurnPurpose = Extract<
  RunPurpose,
  "sender_draft" | "recipient_answer" | "clarification_dialogue"
>;

export interface TaskSessionScope {
  taskId: string;
  peerUserId: string;
  lane: "private_work" | "clarification_dialogue";
  /** Derived from the task by the backend, never accepted as routing authority. */
  participantRole: "requester" | "responder";
  /** Present only for a reserved clarification step. */
  stepId?: string | undefined;
}

/**
 * A turn already assembled by trusted backend conversation orchestration.
 * Runtime ownership and execution policy are intentionally absent.
 */
export type BackendPreparedPrivateTurn = Omit<
  ManagedAgentTurnRequest,
  | "agentId"
  | "workspacePath"
  | "connectorBindingId"
  | "purpose"
  | "sandboxMode"
  | "networkMode"
  | "maxTurns"
  // Not turn content. A model and an effort are routing choices, and routing
  // choices arrive as their own arguments on the input below so the allowlist
  // check cannot be reached around by whatever assembled the prompt.
  | "model"
  | "effort"
> & {
  purpose: PrivateConversationTurnPurpose;
};

export interface AuthorizedPrivateRuntimeTurnInput {
  authorization: Readonly<AuthorizePrivateRuntimeInput>;
  provider: AgentProvider;
  turn: Readonly<BackendPreparedPrivateTurn>;
  /**
   * Which model of `provider` to run, or absent to leave it to the deployment.
   *
   * Validated here against the per-provider allowlist because this is the only
   * caller-chosen value in the whole request. Both CLIs do reject an unknown
   * model themselves, but they reject it after a connector has claimed the
   * turn, so a typo that reaches this far costs the owner a failed draft
   * instead of a 400.
   */
  model?: string | undefined;
  /**
   * How hard `provider` should think, or absent to leave it to the runners.
   *
   * Validated here for the same reason `model` is, and against a sharper
   * failure: neither CLI falls back on an effort it dislikes, and codex-cli
   * additionally rejects per model, so an unchecked rung dies on a connector
   * rather than at the edge. Absent is not "no thinking" -- both runners then
   * apply `DEFAULT_RUNTIME_EFFORT` themselves.
   */
  effort?: RuntimeEffort | undefined;
  /** Optional backend-owned turn ID already claimed in durable draft state. */
  turnId?: string;
  /** Backend-derived task identity. Never accepted from a browser job body. */
  sessionScope?: Readonly<TaskSessionScope> | undefined;
  /** Backend-only task-state check repeated after connector queueing. */
  revalidate?: (() => void | Promise<void>) | undefined;
}

export interface AuthorizedPrivateRuntimeTurnPolicy {
  /** Provider turn budget. Kept small to bound cost and unattended activity. */
  maxTurns: number;
  /** UTF-8 byte bounds prevent multi-byte input from bypassing size policy. */
  maximumRuntimePromptBytes: number;
  maximumPersistedSummaryBytes: number;
}

/** Safe validation error with no caller values, paths, prompts, or secrets. */
export class InvalidPrivateRuntimeTurnError extends Error {
  public readonly code = "INVALID_PRIVATE_RUNTIME_TURN";

  constructor() {
    super("Private runtime turn is invalid");
    this.name = "InvalidPrivateRuntimeTurnError";
  }
}

/**
 * The fail-closed seam from product authorization into Phuong's private
 * provider-session and realtime coordinator.
 *
 * Every call re-authorizes. The caller cannot select the connector binding,
 * local workspace, sandbox, network policy, or execution budget. A future
 * write-capable workflow must use a separate, explicitly reviewed policy seam
 * rather than weakening this private messaging path.
 */
export class AuthorizedPrivateRuntimeTurnStarter {
  constructor(
    private readonly authorizer: PrivateRuntimeAuthorizer,
    private readonly coordinator: PrivateRuntimeTurnCoordinator,
    private readonly policy: Readonly<AuthorizedPrivateRuntimeTurnPolicy>,
  ) {
    validatePolicy(policy);
  }

  async start<T = unknown>(
    input: Readonly<AuthorizedPrivateRuntimeTurnInput>,
  ): Promise<StartedPrivateRuntimeTurn<T>> {
    validateInput(input, this.policy);

    // Authorization intentionally occurs immediately before runtime selection.
    // Do not cache this result: access, trust, membership, and bindings revoke.
    const authorized = await this.authorizer.authorizePrivateRuntime(
      input.authorization,
    );

    const scope: ProviderSessionScope = {
      userId: authorized.userId,
      githubRepositoryId: authorized.githubRepositoryId,
      conversationId: input.authorization.conversationId,
      provider: input.provider,
      ...(input.sessionScope
        ? {
            taskId: input.sessionScope.taskId,
            peerUserId: input.sessionScope.peerUserId,
            lane: input.sessionScope.lane,
            participantRole: input.sessionScope.participantRole,
            ...(input.sessionScope.stepId
              ? { stepId: input.sessionScope.stepId }
              : {}),
          }
        : {}),
      ...(input.model ? { model: input.model } : {}),
    };

    // Explicit construction is a security boundary. Do not spread caller data:
    // untyped JavaScript could otherwise smuggle workspace or policy fields.
    const request: ManagedAgentTurnRequest = {
      agentId: authorized.runtimeBindingId,
      purpose: input.turn.purpose,
      connectorBindingId: authorized.runtimeBindingId,
      runtimePrompt: input.turn.runtimePrompt,
      persistedSummary: input.turn.persistedSummary,
      sessionMode: input.turn.sessionMode ?? "continue",
      sandboxMode: "read-only",
      networkMode: "none",
      outputSchemaName: input.turn.outputSchemaName,
      correlationId: input.turn.correlationId,
      maxTurns: this.policy.maxTurns,
      // Absent stays absent all the way to the argv, so a turn nobody chose a
      // model for behaves exactly as it did before this field existed.
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
    };

    return this.coordinator.start<T>(scope, request, async () => {
      const current = await this.authorizer.authorizePrivateRuntime(
        input.authorization,
      );
      if (!sameRuntimeBinding(authorized, current)) {
        // A rotated/reprovisioned binding is not necessarily hostile, but the
        // queued request targets the old connector binding. Fail closed and let the
        // caller retry through a freshly constructed request.
        throw new PrivateRuntimeAuthorizationError(
          "PRIVATE_RUNTIME_FORBIDDEN",
          "runtime_binding_unavailable",
        );
      }
      await input.revalidate?.();
    }, input.turnId);
  }
}

function sameRuntimeBinding(
  expected: Readonly<AuthorizedPrivateRuntime>,
  current: Readonly<AuthorizedPrivateRuntime>,
): boolean {
  return (
    expected.userId === current.userId &&
    expected.githubRepositoryId === current.githubRepositoryId &&
    expected.runtimeBindingId === current.runtimeBindingId
  );
}

function validatePolicy(policy: Readonly<AuthorizedPrivateRuntimeTurnPolicy>): void {
  if (
    !Number.isInteger(policy.maxTurns) ||
    policy.maxTurns < 1 ||
    policy.maxTurns > 3 ||
    !Number.isInteger(policy.maximumRuntimePromptBytes) ||
    policy.maximumRuntimePromptBytes < 1 ||
    policy.maximumRuntimePromptBytes > 1_048_576 ||
    !Number.isInteger(policy.maximumPersistedSummaryBytes) ||
    policy.maximumPersistedSummaryBytes < 0 ||
    policy.maximumPersistedSummaryBytes > 524_288
  ) {
    throw new Error("Authorized private runtime turn policy is invalid");
  }
}

function validateInput(
  input: Readonly<AuthorizedPrivateRuntimeTurnInput>,
  policy: Readonly<AuthorizedPrivateRuntimeTurnPolicy>,
): void {
  if (
    !input ||
    typeof input !== "object" ||
    !input.authorization ||
    typeof input.authorization !== "object" ||
    !input.turn ||
    typeof input.turn !== "object" ||
    !providers.has(input.provider) ||
    !privateTurnPurposes.has(input.turn.purpose) ||
    (input.turn.sessionMode !== undefined &&
      !sessionModes.has(input.turn.sessionMode)) ||
    !validBoundedText(
      input.turn.runtimePrompt,
      policy.maximumRuntimePromptBytes,
      false,
    ) ||
    !validBoundedText(
      input.turn.persistedSummary,
      policy.maximumPersistedSummaryBytes,
      true,
    ) ||
    typeof input.turn.outputSchemaName !== "string" ||
    !outputSchemaNamePattern.test(input.turn.outputSchemaName) ||
    typeof input.turn.correlationId !== "string" ||
    !correlationIdPattern.test(input.turn.correlationId) ||
    (input.turnId !== undefined &&
      (typeof input.turnId !== "string" || !correlationIdPattern.test(input.turnId))) ||
    (input.model !== undefined &&
      (typeof input.model !== "string" ||
        !isSupportedModel(input.provider, input.model))) ||
    (input.effort !== undefined &&
      (typeof input.effort !== "string" || !isSupportedEffort(input.effort))) ||
    !validTaskSessionScope(input)
  ) {
    throw new InvalidPrivateRuntimeTurnError();
  }
}

function validTaskSessionScope(
  input: Readonly<AuthorizedPrivateRuntimeTurnInput>,
): boolean {
  const scope = input.sessionScope;
  if (!scope) return input.turn.purpose !== "clarification_dialogue";
  if (
    !correlationIdPattern.test(scope.taskId) ||
    !correlationIdPattern.test(scope.peerUserId) ||
    scope.peerUserId === input.authorization.authenticatedUserId ||
    (scope.participantRole !== "requester" &&
      scope.participantRole !== "responder") ||
    (scope.stepId !== undefined && !correlationIdPattern.test(scope.stepId))
  ) {
    return false;
  }
  // A dialogue turn must carry its reserved step, and a private work turn must
  // never claim one: that is what keeps the two lanes from sharing a session.
  return input.turn.purpose === "clarification_dialogue"
    ? scope.lane === "clarification_dialogue" &&
        scope.stepId !== undefined &&
        input.turn.outputSchemaName === "clarification-dialogue.schema.json"
    : scope.lane === "private_work" && scope.stepId === undefined;
}

function validBoundedText(value: unknown, maximumBytes: number, allowEmpty: boolean): boolean {
  return (
    typeof value === "string" &&
    value.length <= maximumBytes &&
    !value.includes("\u0000") &&
    (allowEmpty || value.trim().length > 0) &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}
