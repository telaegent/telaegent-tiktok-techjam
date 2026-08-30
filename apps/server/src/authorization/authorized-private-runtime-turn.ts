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
]);
const sessionModes = new Set<SessionMode>(["continue", "fresh", "ephemeral"]);
const providers = new Set<AgentProvider>(["codex", "claude"]);

export type PrivateConversationTurnPurpose = Extract<
  RunPurpose,
  "sender_draft" | "recipient_answer"
>;

/**
 * A turn already assembled by trusted backend conversation orchestration.
 * Runtime ownership and execution policy are intentionally absent.
 */
export type BackendPreparedPrivateTurn = Omit<
  ManagedAgentTurnRequest,
  | "agentId"
  | "workspacePath"
  | "purpose"
  | "sandboxMode"
  | "networkMode"
  | "maxTurns"
> & {
  purpose: PrivateConversationTurnPurpose;
};

export interface AuthorizedPrivateRuntimeTurnInput {
  authorization: Readonly<AuthorizePrivateRuntimeInput>;
  provider: AgentProvider;
  turn: Readonly<BackendPreparedPrivateTurn>;
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
 * Every call re-authorizes. The caller cannot select the runtime binding,
 * workspace, sandbox, network policy, or execution budget. A future
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
      repositoryId: authorized.githubRepositoryId,
      conversationId: input.authorization.conversationId,
      provider: input.provider,
    };

    // Explicit construction is a security boundary. Do not spread caller data:
    // untyped JavaScript could otherwise smuggle workspace or policy fields.
    const request: ManagedAgentTurnRequest = {
      agentId: authorized.runtimeBindingId,
      purpose: input.turn.purpose,
      workspacePath: authorized.workspacePath,
      runtimePrompt: input.turn.runtimePrompt,
      persistedSummary: input.turn.persistedSummary,
      sessionMode: input.turn.sessionMode ?? "continue",
      sandboxMode: "read-only",
      networkMode: "none",
      outputSchemaName: input.turn.outputSchemaName,
      correlationId: input.turn.correlationId,
      maxTurns: this.policy.maxTurns,
    };

    return this.coordinator.start<T>(scope, request, async () => {
      const current = await this.authorizer.authorizePrivateRuntime(
        input.authorization,
      );
      if (!sameRuntimeBinding(authorized, current)) {
        // A rotated/reprovisioned binding is not necessarily hostile, but the
        // queued request contains the old workspace. Fail closed and let the
        // caller retry through a freshly constructed request.
        throw new PrivateRuntimeAuthorizationError(
          "PRIVATE_RUNTIME_FORBIDDEN",
          "runtime_binding_unavailable",
        );
      }
    });
  }
}

function sameRuntimeBinding(
  expected: Readonly<AuthorizedPrivateRuntime>,
  current: Readonly<AuthorizedPrivateRuntime>,
): boolean {
  return (
    expected.userId === current.userId &&
    expected.githubRepositoryId === current.githubRepositoryId &&
    expected.runtimeBindingId === current.runtimeBindingId &&
    expected.workspacePath === current.workspacePath
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
    !correlationIdPattern.test(input.turn.correlationId)
  ) {
    throw new InvalidPrivateRuntimeTurnError();
  }
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
