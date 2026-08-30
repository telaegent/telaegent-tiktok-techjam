import { describe, expect, it } from "vitest";
import { RunCancelledError } from "./errors.js";
import {
  RuntimeProviderError,
  classifyProviderFailure,
  normalizeRuntimeFailure,
  safeRuntimeError,
} from "./runtime-errors.js";

describe("classifyProviderFailure", () => {
  it("classifies missing provider sessions without exposing provider output", () => {
    const error = classifyProviderFailure(
      "codex",
      "Failed to resume thread 0199: thread not found",
    );

    expect(error.code).toBe("RUNTIME_SESSION_NOT_FOUND");
    expect(error.message).toBe("Codex session is no longer available");
    expect(error.message).not.toContain("0199");
  });

  it("classifies the current Codex missing-rollout wording as a missing session", () => {
    const error = classifyProviderFailure(
      "codex",
      "thread/resume failed: no rollout found for thread id private-id",
    );

    expect(error.code).toBe("RUNTIME_SESSION_NOT_FOUND");
    expect(error.message).toBe("Codex session is no longer available");
    expect(error.message).not.toContain("private-id");
  });

  it("keeps authentication failures distinct from missing sessions", () => {
    expect(classifyProviderFailure("claude", "Login required").code).toBe(
      "RUNTIME_AUTHENTICATION_FAILED",
    );
  });

  it.each([
    ["request timed out after 120000ms", "RUNTIME_TIMEOUT"],
    ["spawn codex ENOENT", "RUNTIME_UNAVAILABLE"],
    ["429 too many requests", "RUNTIME_UNAVAILABLE"],
    ["malformed JSON response containing private-data", "INVALID_AGENT_OUTPUT"],
    ["unrecognized provider explosion", "RUNTIME_FAILED"],
  ] as const)("classifies %s as %s", (detail, code) => {
    const error = classifyProviderFailure("codex", detail);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(detail);
  });
});

describe("normalizeRuntimeFailure", () => {
  it("replaces even explicitly constructed runtime messages with canonical text", () => {
    const failure = normalizeRuntimeFailure(
      new RuntimeProviderError(
        "RUNTIME_AUTHENTICATION_FAILED",
        "token=super-secret provider stderr",
      ),
    );

    expect(failure).toEqual({
      code: "RUNTIME_AUTHENTICATION_FAILED",
      message: "Agent provider authentication is required",
      retryable: false,
      statusCode: 424,
    });
    expect(safeRuntimeError(
      new RuntimeProviderError("RUNTIME_FAILED", "private provider stderr"),
    ).message).toBe("Agent runtime failed");
  });

  it("normalizes cancellation without treating it as a provider failure", () => {
    expect(normalizeRuntimeFailure(new RunCancelledError())).toEqual({
      code: "RUNTIME_CANCELLED",
      message: "Agent provider turn was cancelled",
      retryable: false,
      statusCode: 409,
    });
  });

  it("collapses unknown exceptions to a retryable generic failure", () => {
    expect(normalizeRuntimeFailure(new Error("credential and session details"))).toEqual({
      code: "RUNTIME_FAILED",
      message: "Agent runtime failed",
      retryable: true,
      statusCode: 502,
    });
  });
});
