import { describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  classifyClaudeFailure,
  completedStructuredOutputBeforeMaxTurns,
  extractClaudeFinalResult,
  parseClaudeStreamLine,
  type ParsedClaudeEvents,
} from "./claude-code-runner.js";
import type {
  MiddlewareRunRequest,
  RuntimeProgressEvent,
} from "./runtime-contract.js";

const request = (
  overrides: Partial<MiddlewareRunRequest> = {},
): MiddlewareRunRequest => ({
  agentId: "agent",
  provider: "claude",
  purpose: "status",
  workspacePath: "/tmp/workspace",
  runtimePrompt: "Return status",
  persistedSummary: "Status check",
  sessionMode: "fresh",
  sandboxMode: "read-only",
  networkMode: "none",
  outputSchemaName: "status.schema.json",
  correlationId: "corr-1",
  maxTurns: 2,
  ...overrides,
});

const emptyParsed = (): ParsedClaudeEvents => ({
  sessionId: null,
  structuredOutput: undefined,
  resultText: null,
  resultSubtype: null,
  errors: [],
});

describe("Claude Code runner protocol", () => {
  it("builds a bounded read-only invocation without bypass flags", () => {
    const args = buildClaudeArgs(request(), { type: "object" });
    expect(args).toContain("stream-json");
    expect(args).toContain("--json-schema");
    expect(args).toContain("--max-turns");
    expect(args).toContain("2");
    expect(args).toContain("plan");
    expect(args).toContain("Read,Glob,Grep");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args).not.toContain("--no-session-persistence");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("Return status");
  });

  it("removes the unsupported JSON Schema dialect before launching Claude", () => {
    const args = buildClaudeArgs(request(), {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { state: { type: "string" } },
      required: ["state"],
      additionalProperties: false,
    });
    const encoded = args[args.indexOf("--json-schema") + 1];

    expect(encoded).toBeDefined();
    expect(JSON.parse(encoded!)).toEqual({
      type: "object",
      properties: { state: { type: "string" } },
      required: ["state"],
      additionalProperties: false,
    });
  });

  it("disables persistence only for an explicitly ephemeral session", () => {
    const args = buildClaudeArgs(
      request({ sessionMode: "ephemeral" }),
      { type: "object" },
    );
    expect(args).toContain("--no-session-persistence");
  });

  it("resumes only an explicitly continuing session", () => {
    const args = buildClaudeArgs(
      request({
        purpose: "implement",
        sessionMode: "continue",
        sessionId: "session-123",
        sandboxMode: "workspace-write",
        networkMode: "default",
      }),
      { type: "object" },
    );
    expect(args).toContain("--resume");
    expect(args).toContain("session-123");
    expect(args).not.toContain("--no-session-persistence");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("Return status");
  });

  it("rejects writable runs that claim local network isolation", () => {
    expect(() =>
      buildClaudeArgs(
        request({
          purpose: "implement",
          sandboxMode: "workspace-write",
          networkMode: "none",
        }),
        { type: "object" },
      ),
    ).toThrow("cannot guarantee network isolation");
  });

  it("extracts a session and structured final result", () => {
    const parsed = emptyParsed();
    parseClaudeStreamLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" }),
      parsed,
    );
    parseClaudeStreamLine(
      JSON.stringify({
        type: "result",
        session_id: "session-1",
        structured_output: { publicSummary: "Ready" },
      }),
      parsed,
    );
    expect(parsed.sessionId).toBe("session-1");
    expect(extractClaudeFinalResult(parsed)).toEqual({ publicSummary: "Ready" });
  });

  it("classifies every Claude error when a generic terminal error follows a missing session", () => {
    const parsed = emptyParsed();
    parseClaudeStreamLine(
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "Claude Code reported an error",
        errors: ["No conversation found with session ID: stale-session"],
      }),
      parsed,
    );

    expect(parsed.errors).toEqual([
      "Claude Code reported an error",
      "No conversation found with session ID: stale-session",
    ]);
    expect(classifyClaudeFailure(parsed.errors)).toMatchObject({
      code: "RUNTIME_SESSION_NOT_FOUND",
    });
  });

  it("normalizes live Claude session, text, retry, and completion events", () => {
    const parsed = emptyParsed();
    const progress: RuntimeProgressEvent[] = [];
    const emit = (event: RuntimeProgressEvent) => progress.push(event);

    parseClaudeStreamLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" }),
      parsed,
      emit,
    );
    parseClaudeStreamLine(
      JSON.stringify({
        type: "stream_event",
        event: { type: "message_start" },
      }),
      parsed,
      emit,
    );
    parseClaudeStreamLine(
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Working" },
        },
      }),
      parsed,
      emit,
    );
    parseClaudeStreamLine(
      JSON.stringify({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 750,
      }),
      parsed,
      emit,
    );
    parseClaudeStreamLine(
      JSON.stringify({ type: "result", structured_output: { state: "ready" } }),
      parsed,
      emit,
    );

    expect(progress).toEqual([
      { type: "session_started", provider: "claude" },
      { type: "turn_started", provider: "claude" },
      { type: "text_delta", provider: "claude", text: "Working" },
      {
        type: "retrying",
        provider: "claude",
        attempt: 2,
        maxRetries: 5,
        retryDelayMs: 750,
      },
      { type: "turn_completed", provider: "claude" },
    ]);
  });

  it("rejects invalid stream JSON and missing structured output", () => {
    expect(() => parseClaudeStreamLine("not-json", emptyParsed())).toThrow(
      "invalid event stream",
    );
    expect(() => extractClaudeFinalResult(emptyParsed())).toThrow(
      "without structured output",
    );
  });

  it("retains completed structured output when old Claude exhausts turns afterward", () => {
    const parsed = emptyParsed();
    parseClaudeStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        structured_output: {
          state: "ready",
          assistantMessage: "Ready for review.",
          sendCandidate: "Can you clarify the expected behavior?",
          riskFlags: [],
          referencedPaths: [],
        },
        errors: ["Claude Code reported an internal provider detail"],
      }),
      parsed,
    );

    expect(completedStructuredOutputBeforeMaxTurns(parsed)).toBe(true);
    expect(extractClaudeFinalResult(parsed)).toMatchObject({ state: "ready" });
  });

  it("does not suppress execution errors merely because they include output", () => {
    const parsed = emptyParsed();
    parseClaudeStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        structured_output: { state: "ready" },
      }),
      parsed,
    );

    expect(completedStructuredOutputBeforeMaxTurns(parsed)).toBe(false);
  });

  it("preserves current Claude stream errors for local failure classification", () => {
    const parsed = emptyParsed();
    parseClaudeStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [
          "No conversation found with session ID: 00000000-0000-0000-0000-000000000000",
        ],
      }),
      parsed,
    );

    expect(classifyClaudeFailure(parsed.errors.at(-1)).code).toBe(
      "RUNTIME_SESSION_NOT_FOUND",
    );
  });

  it("classifies authentication failures without leaking provider detail", () => {
    const error = classifyClaudeFailure("401 invalid API key sk-private-value");
    expect(error.code).toBe("RUNTIME_AUTHENTICATION_FAILED");
    expect(error.message).toBe("Claude Code authentication failed");
    expect(error.message).not.toContain("sk-private-value");
  });

  it("retains Claude's local errors array for safe resume-failure classification", () => {
    const parsed = emptyParsed();
    parseClaudeStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["No conversation found with session ID: private-session-id"],
      }),
      parsed,
    );

    const error = classifyClaudeFailure(parsed.errors.at(-1));
    expect(error.code).toBe("RUNTIME_SESSION_NOT_FOUND");
    expect(error.message).toBe("Claude Code session is no longer available");
    expect(error.message).not.toContain("private-session-id");
  });
});
