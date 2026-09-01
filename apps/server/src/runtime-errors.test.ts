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

  it("classifies every Codex error when a generic terminal error follows the cause", () => {
    const error = classifyProviderFailure("codex", [
      "no rollout found for thread id private-id",
      "provider failed",
    ]);

    expect(error.code).toBe("RUNTIME_SESSION_NOT_FOUND");
    expect(error.message).not.toContain("private-id");
  });

  it("classifies the current Claude missing-conversation wording as a missing session", () => {
    const error = classifyProviderFailure(
      "claude",
      "No conversation found with session ID: 00000000-0000-0000-0000-000000000000",
      { phase: "provider_exit", exitCode: 1 },
    );

    expect(error.code).toBe("RUNTIME_SESSION_NOT_FOUND");
    expect(error.message).toBe("Claude Code session is no longer available");
    expect(error.message).not.toContain("00000000-0000-0000-0000-000000000000");
    expect(error.localDiagnostic).toEqual({
      phase: "provider_exit",
      exitCode: 1,
    });
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
    [
      "--json-schema is not a valid JSON Schema: no schema with key or ref private-uri",
      "INVALID_AGENT_OUTPUT",
    ],
    [
      "Invalid schema for response_format: 'const' is not permitted",
      "INVALID_AGENT_OUTPUT",
    ],
    ["You have hit your usage limit", "RUNTIME_UNAVAILABLE"],
    ["The configured model is deprecated", "RUNTIME_UNAVAILABLE"],
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

  it("preserves safe local diagnostics without serializing them", () => {
    const safe = safeRuntimeError(
      new RuntimeProviderError(
        "RUNTIME_FAILED",
        "private provider stderr",
        { phase: "provider_exit", exitCode: 1 },
      ),
    ) as RuntimeProviderError;

    expect(safe.message).toBe("Agent runtime failed");
    expect(safe.localDiagnostic).toEqual({ phase: "provider_exit", exitCode: 1 });
    expect(normalizeRuntimeFailure(safe)).toEqual({
      code: "RUNTIME_FAILED",
      message: "Agent runtime failed",
      retryable: true,
      statusCode: 502,
    });
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

  it("classifies TLS trust failures as an unavailable runtime", () => {
    const messages = [
      "error sending request for url (https://chatgpt.com/backend-api/codex/responses): client error (Connect): invalid peer certificate: UnknownIssuer",
      "invalid peer certificate: UnknownIssuer",
      "unable to get local issuer certificate",
      "self-signed certificate in certificate chain",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "CERT_HAS_EXPIRED",
      "certificate authority is not trusted",
      "tls handshake eof",
    ];
    for (const message of messages) {
      expect(classifyProviderFailure("codex", message).code).toBe("RUNTIME_UNAVAILABLE");
    }
  });

  it("classifies generic transport failures as an unavailable runtime", () => {
    for (const message of ["error sending request", "connection failure", "tcp connect error"]) {
      expect(classifyProviderFailure("codex", message).code).toBe("RUNTIME_UNAVAILABLE");
    }
  });

  it("keeps authentication ahead of transport wording", () => {
    const error = classifyProviderFailure(
      "codex",
      "error sending request: 401 unauthorized invalid api key",
    );
    expect(error.code).toBe("RUNTIME_AUTHENTICATION_FAILED");
  });

  it("never exposes the certificate subject through a transport failure", () => {
    const error = classifyProviderFailure(
      "codex",
      "invalid peer certificate: UnknownIssuer CN=corp-proxy.internal",
    );
    expect(normalizeRuntimeFailure(error).message).toBe(
      "Agent provider is temporarily unavailable",
    );
  });
});
