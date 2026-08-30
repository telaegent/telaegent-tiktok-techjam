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
  ) {
    super(message);
    this.name = "RuntimeProviderError";
  }
}

const authenticationPattern =
  /(?:401|unauthori[sz]ed|authentication|invalid\s+(?:api\s*)?key|api[_ -]?key|login required|not logged in)/i;

const missingSessionPattern =
  /(?:(?:session|thread)\s+(?:id\s+)?(?:was\s+)?not\s+found|no\s+(?:session|thread)\s+found|no\s+rollout\s+found\s+for\s+thread\s+id|unknown\s+(?:session|thread)|failed\s+to\s+(?:load|resume)\s+(?:session|thread)|(?:session|thread)\s+(?:is\s+)?(?:missing|unavailable|does\s+not\s+exist))/i;

const timeoutPattern = /(?:ETIMEDOUT|timed?\s*out|timeout)/i;

const unavailablePattern =
  /(?:ENOENT|command not found|not recognized as an internal or external command|ECONNREFUSED|ECONNRESET|ENOTFOUND|service unavailable|temporarily unavailable|provider overloaded|rate limit|too many requests|\b429\b)/i;

const invalidOutputPattern =
  /(?:invalid|malformed|unexpected)\s+(?:json|output|response|event|stream)|failed to (?:parse|decode)/i;

export function classifyProviderFailure(
  provider: AgentProvider,
  detail: unknown,
): RuntimeProviderError {
  const raw = detail instanceof Error ? detail.message : String(detail ?? "");
  const label = provider === "codex" ? "Codex" : "Claude Code";
  if (authenticationPattern.test(raw)) {
    return new RuntimeProviderError(
      "RUNTIME_AUTHENTICATION_FAILED",
      label + " authentication failed",
    );
  }
  if (missingSessionPattern.test(raw)) {
    return new RuntimeProviderError(
      "RUNTIME_SESSION_NOT_FOUND",
      label + " session is no longer available",
    );
  }
  if (timeoutPattern.test(raw)) {
    return new RuntimeProviderError("RUNTIME_TIMEOUT", label + " runtime timed out");
  }
  if (unavailablePattern.test(raw)) {
    return new RuntimeProviderError(
      "RUNTIME_UNAVAILABLE",
      label + " runtime is unavailable",
    );
  }
  if (invalidOutputPattern.test(raw)) {
    return new RuntimeProviderError(
      "INVALID_AGENT_OUTPUT",
      label + " returned invalid output",
    );
  }
  return new RuntimeProviderError("RUNTIME_FAILED", label + " runtime failed");
}

export function safeRuntimeError(error: unknown): Error {
  if (error instanceof RunCancelledError) return error;
  if (error instanceof RuntimeProviderError) {
    const normalized = normalizeRuntimeFailure(error);
    return new RuntimeProviderError(error.code, normalized.message);
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
