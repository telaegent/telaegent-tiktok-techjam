import { RunCancelledError } from "./errors.js";
import type {
  AgentProvider,
  PublicRuntimeErrorCode,
  RuntimeErrorCode,
} from "./runtime-contract.js";

export type { PublicRuntimeErrorCode, RuntimeErrorCode } from "./runtime-contract.js";

export interface NormalizedRuntimeFailure {
  code: PublicRuntimeErrorCode;
  message: string;
  retryable: boolean;
  statusCode: number;
}

export type LocalRuntimeFailurePhase =
  | "concurrency"
  | "spawn"
  | "event_stream"
  | "provider_exit"
  | "structured_output"
  | "timeout"
  | "output_limit";

/** Local-only structural evidence. normalizeRuntimeFailure never serializes it. */
export interface LocalRuntimeFailureDiagnostic {
  phase: LocalRuntimeFailurePhase;
  exitCode?: number | undefined;
}

const runtimeFailureDefinitions: Record<
  PublicRuntimeErrorCode,
  Omit<NormalizedRuntimeFailure, "code">
> = {
  RUNTIME_UNAVAILABLE: {
    message: "Agent provider is temporarily unavailable",
    retryable: true,
    statusCode: 503,
  },
  RUNTIME_AUTHENTICATION_FAILED: {
    message: "Agent provider authentication is required",
    retryable: false,
    statusCode: 424,
  },
  RUNTIME_SESSION_NOT_FOUND: {
    message: "Agent provider session is no longer available",
    retryable: true,
    statusCode: 409,
  },
  RUNTIME_TIMEOUT: {
    message: "Agent runtime timed out",
    retryable: true,
    statusCode: 504,
  },
  RUNTIME_OUTPUT_LIMIT: {
    message: "Agent provider output exceeded the allowed limit",
    retryable: false,
    statusCode: 502,
  },
  INVALID_AGENT_OUTPUT: {
    message: "Agent provider returned invalid output",
    retryable: true,
    statusCode: 502,
  },
  UNSUPPORTED_RUNTIME_POLICY: {
    message: "Requested agent runtime policy is unsupported",
    retryable: false,
    statusCode: 400,
  },
  RUNTIME_FAILED: {
    message: "Agent runtime failed",
    retryable: true,
    statusCode: 502,
  },
  RUNTIME_CANCELLED: {
    message: "Agent provider turn was cancelled",
    retryable: false,
    statusCode: 409,
  },
};

export class RuntimeProviderError extends Error {
  constructor(
    public readonly code: RuntimeErrorCode,
    message: string,
    public readonly localDiagnostic?: Readonly<LocalRuntimeFailureDiagnostic>,
  ) {
    super(message);
    this.name = "RuntimeProviderError";
  }
}

const authenticationPattern =
  /(?:401|unauthori[sz]ed|authentication|invalid\s+(?:api\s*)?key|api[_ -]?key|login required|not logged in)/i;

const missingSessionPattern =
  /(?:(?:session|thread)\s+(?:id\s+)?(?:was\s+)?not\s+found|no\s+(?:session|thread)\s+found|no\s+conversation\s+found\s+with\s+session\s+id|no\s+rollout\s+found\s+for\s+thread\s+id|unknown\s+(?:session|thread)|failed\s+to\s+(?:load|resume)\s+(?:session|thread)|(?:session|thread)\s+(?:is\s+)?(?:missing|unavailable|does\s+not\s+exist))/i;

const timeoutPattern = /(?:ETIMEDOUT|timed?\s*out|timeout)/i;

/**
 * Exhausted capacity, including the plan quotas both CLIs report in prose. A
 * spent Codex or Claude allowance says "usage limit", never "rate limit", so
 * without these the only actionable failure a developer can hit on a normal
 * day degrades to RUNTIME_FAILED and hides the wait-and-retry instruction.
 * A retired or unentitled model belongs here too: the turn cannot succeed now
 * but the runtime itself is intact, which is what RUNTIME_UNAVAILABLE means.
 */
const unavailablePattern =
  /(?:ENOENT|command not found|not recognized as an internal or external command|ECONNREFUSED|ECONNRESET|ENOTFOUND|service unavailable|temporarily unavailable|provider overloaded|rate limit|too many requests|\b429\b|usage limit|\bquota\b|out of credits|insufficient credits|purchase more credits|model (?:is )?(?:unavailable|unsupported|retired|deprecated)|does not have access to (?:the )?model|requires a newer version of codex|upgrade to the latest (?:app|cli|app or cli))/i;

/**
 * Transport-layer failures raised before the CLI ever reaches the model.
 * Certificate rejections dominate on intercepted corporate networks, where the
 * standalone CLI only succeeds because it read a trust anchor of its own.
 */
const transportFailurePattern =
  /(?:invalid peer certificate|unknown\s*issuer|self[\s-]?signed certificate|certificate (?:has expired|verify failed|is not trusted|chain)|certificate authority|unable to (?:get local issuer certificate|verify the first certificate)|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|CERT_UNTRUSTED|ERR_TLS_CERT_ALTNAME_INVALID|\btls\b|\bssl\b|handshake (?:failed|failure|eof)|\bEPROTO\b|error sending request|connection (?:failure|failed|error)|failed to connect|tcp connect error|network (?:is )?unreachable|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN)/i;

const invalidOutputPattern =
  /(?:invalid|malformed|unexpected)\s+(?:json|output|response|event|stream|schema)|failed to (?:parse|decode)|not a valid json schema|(?:json )?schema[^\r\n]*(?:invalid|unsupported|not permitted)|no schema with key or ref/i;

export function classifyProviderFailure(
  provider: AgentProvider,
  detail: unknown,
  localDiagnostic?: Readonly<LocalRuntimeFailureDiagnostic>,
): RuntimeProviderError {
  const raw = detail instanceof Error ? detail.message : String(detail ?? "");
  const label = provider === "codex" ? "Codex" : "Claude Code";
  if (authenticationPattern.test(raw)) {
    return new RuntimeProviderError(
      "RUNTIME_AUTHENTICATION_FAILED",
      label + " authentication failed",
      localDiagnostic,
    );
  }
  if (missingSessionPattern.test(raw)) {
    return new RuntimeProviderError(
      "RUNTIME_SESSION_NOT_FOUND",
      label + " session is no longer available",
      localDiagnostic,
    );
  }
  if (timeoutPattern.test(raw)) {
    return new RuntimeProviderError(
      "RUNTIME_TIMEOUT",
      label + " runtime timed out",
      localDiagnostic,
    );
  }
  if (unavailablePattern.test(raw) || transportFailurePattern.test(raw)) {
    return new RuntimeProviderError(
      "RUNTIME_UNAVAILABLE",
      label + " runtime is unavailable",
      localDiagnostic,
    );
  }
  if (invalidOutputPattern.test(raw)) {
    return new RuntimeProviderError(
      "INVALID_AGENT_OUTPUT",
      label + " returned invalid output",
      localDiagnostic,
    );
  }
  return new RuntimeProviderError(
    "RUNTIME_FAILED",
    label + " runtime failed",
    localDiagnostic,
  );
}

export function safeRuntimeError(error: unknown): Error {
  if (error instanceof RunCancelledError) return error;
  if (error instanceof RuntimeProviderError) {
    const normalized = normalizeRuntimeFailure(error);
    return new RuntimeProviderError(
      error.code,
      normalized.message,
      error.localDiagnostic,
    );
  }
  const normalized = normalizeRuntimeFailure(error);
  return new RuntimeProviderError("RUNTIME_FAILED", normalized.message);
}

/**
 * Converts every provider/runtime exception into the only failure shape that
 * may cross the HTTP or realtime boundary. Raw CLI output is never retained.
 */
export function normalizeRuntimeFailure(error: unknown): NormalizedRuntimeFailure {
  const code: PublicRuntimeErrorCode =
    error instanceof RunCancelledError
      ? "RUNTIME_CANCELLED"
      : error instanceof RuntimeProviderError
        ? error.code
        : "RUNTIME_FAILED";
  return { code, ...runtimeFailureDefinitions[code] };
}
