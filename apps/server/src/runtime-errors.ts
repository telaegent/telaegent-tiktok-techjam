import { RunCancelledError } from "./errors.js";
import type { AgentProvider } from "./runtime-contract.js";

export type RuntimeErrorCode =
  | "RUNTIME_UNAVAILABLE"
  | "RUNTIME_AUTHENTICATION_FAILED"
  | "RUNTIME_SESSION_NOT_FOUND"
  | "RUNTIME_TIMEOUT"
  | "RUNTIME_OUTPUT_LIMIT"
  | "INVALID_AGENT_OUTPUT"
  | "UNSUPPORTED_RUNTIME_POLICY"
  | "RUNTIME_FAILED";

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
  return new RuntimeProviderError("RUNTIME_FAILED", label + " runtime failed");
}

export function safeRuntimeError(error: unknown): Error {
  if (error instanceof RunCancelledError || error instanceof RuntimeProviderError) {
    return error;
  }
  return new RuntimeProviderError("RUNTIME_FAILED", "Agent runtime failed");
}
