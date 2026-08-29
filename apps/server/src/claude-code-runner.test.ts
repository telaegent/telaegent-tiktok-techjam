import { describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  classifyClaudeFailure,
  extractClaudeFinalResult,
  parseClaudeStreamLine,
  type ParsedClaudeEvents,
} from "./claude-code-runner.js";
import type { MiddlewareRunRequest } from "./runtime-contract.js";

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
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("Return status");
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
