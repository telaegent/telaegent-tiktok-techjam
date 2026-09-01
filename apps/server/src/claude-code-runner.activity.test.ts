import { describe, expect, it } from "vitest";
import type { RuntimeProgressEvent } from "./runtime-contract.js";
import {
  claudeToolActivity,
  claudeToolTarget,
  parseClaudeStreamLine,
  type ParsedClaudeEvents,
} from "./claude-code-runner.js";

function freshParsed(): ParsedClaudeEvents {
  return {
    sessionId: null,
    structuredOutput: undefined,
    resultText: null,
    resultSubtype: null,
    errors: [],
  };
}

function collect(event: unknown): RuntimeProgressEvent[] {
  const events: RuntimeProgressEvent[] = [];
  parseClaudeStreamLine(JSON.stringify(event), freshParsed(), (progress) => {
    events.push(progress);
  });
  return events;
}

describe("claudeToolActivity", () => {
  it("maps read-only tools to tool", () => {
    expect(claudeToolActivity("Read")).toBe("tool");
    expect(claudeToolActivity("Glob")).toBe("tool");
    expect(claudeToolActivity("Grep")).toBe("tool");
  });

  it("maps shells to command and writes to file_change", () => {
    expect(claudeToolActivity("Bash")).toBe("command");
    expect(claudeToolActivity("PowerShell")).toBe("command");
    expect(claudeToolActivity("Edit")).toBe("file_change");
    expect(claudeToolActivity("Write")).toBe("file_change");
  });

  it("maps web and mcp tools", () => {
    expect(claudeToolActivity("WebFetch")).toBe("web_search");
    expect(claudeToolActivity("WebSearch")).toBe("web_search");
    expect(claudeToolActivity("mcp__github__list_issues")).toBe("mcp");
  });

  it("returns null for an unknown tool rather than guessing", () => {
    expect(claudeToolActivity("StructuredOutput")).toBeNull();
    expect(claudeToolActivity("")).toBeNull();
  });
});

describe("claudeToolTarget", () => {
  it("reads file_path", () => {
    expect(claudeToolTarget({ file_path: "/repo/src/a.ts" })).toBe("/repo/src/a.ts");
  });

  it("prefers file_path over path", () => {
    expect(claudeToolTarget({ file_path: "/repo/a.ts", path: "/repo" })).toBe("/repo/a.ts");
  });

  it("falls back to path", () => {
    expect(claudeToolTarget({ path: "/repo/src" })).toBe("/repo/src");
  });

  it("returns null when there is no path-shaped input", () => {
    expect(claudeToolTarget({ pattern: "TODO" })).toBeNull();
    expect(claudeToolTarget({ command: "ls" })).toBeNull();
    expect(claudeToolTarget(null)).toBeNull();
  });
});

describe("parseClaudeStreamLine activity", () => {
  it("emits activity_started with a target for a Read tool_use block", () => {
    expect(
      collect({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "let me look" },
            { type: "tool_use", name: "Read", input: { file_path: "/repo/src/auth/session.ts" } },
          ],
        },
      }),
    ).toEqual([
      {
        type: "activity_started",
        provider: "claude",
        activity: "tool",
        target: "/repo/src/auth/session.ts",
      },
    ]);
  });

  it("emits one event per tool_use block", () => {
    expect(
      collect({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Glob", input: { path: "/repo/src" } },
            { type: "tool_use", name: "Read", input: { file_path: "/repo/a.ts" } },
          ],
        },
      }),
    ).toHaveLength(2);
  });

  it("omits target when the tool has no path input", () => {
    expect(
      collect({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "TODO" } }] },
      }),
    ).toEqual([{ type: "activity_started", provider: "claude", activity: "tool" }]);
  });

  it("ignores an unknown tool", () => {
    expect(
      collect({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "StructuredOutput", input: {} }] },
      }),
    ).toEqual([]);
  });

  it("ignores a malformed assistant event without throwing", () => {
    expect(() => collect({ type: "assistant" })).not.toThrow();
    expect(collect({ type: "assistant", message: { content: "nope" } })).toEqual([]);
  });
});
