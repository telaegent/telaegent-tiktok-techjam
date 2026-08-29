import { describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  classifyClaudeFailure,
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
      { type: "session_started", provider: "claude", sessionId: "session-1" },
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

  it("classifies authentication failures without leaking provider detail", () => {
    const error = classifyClaudeFailure("401 invalid API key sk-private-value");
    expect(error.code).toBe("RUNTIME_AUTHENTICATION_FAILED");
    expect(error.message).toBe("Claude Code authentication failed");
    expect(error.message).not.toContain("sk-private-value");
  });
});
