import { describe, expect, it, vi } from "vitest";
import {
  CodexRunner,
  buildCodexArgs,
  buildCodexMiddlewareArgs,
  parseCodexEventLine,
  type CodexRunnerDependencies,
} from "./codex-runner.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import type { RuntimeProgressEvent } from "./runtime-contract.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("uses an explicit local model without changing the global Codex default", () => {
    const request = {
      agentId: "agent",
      workspacePath: "/tmp/workspace",
      prompt: "build a calculator",
      threadId: null,
    };

    expect(
      buildCodexArgs(request, "read-only", request.workspacePath, "gpt-5.5"),
    ).toContain("gpt-5.5");
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("normalizes live Codex session, activity, text, and completion events", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
    };
    const progress: RuntimeProgressEvent[] = [];
    const emit = (event: RuntimeProgressEvent) => progress.push(event);

    for (const event of [
      { type: "thread.started", thread_id: "thread-123" },
      { type: "turn.started" },
      { type: "item.started", item: { type: "command_execution" } },
      { type: "item.completed", item: { type: "command_execution" } },
      { type: "item.completed", item: { type: "agent_message", text: "Done." } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } },
    ]) {
      parseCodexEventLine(JSON.stringify(event), parsed, emit);
    }

    expect(progress).toEqual([
      { type: "session_started", provider: "codex" },
      { type: "turn_started", provider: "codex" },
      { type: "activity_started", provider: "codex", activity: "command" },
      { type: "activity_completed", provider: "codex", activity: "command" },
      { type: "text_delta", provider: "codex", text: "Done." },
      { type: "turn_completed", provider: "codex" },
    ]);
  });

  it("rejects non-JSON stdout in JSONL mode", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
    };
    expect(() => parseCodexEventLine("not-json", parsed)).toThrow(
      "invalid event stream",
    );
  });

  it("builds a structured read-only middleware invocation", () => {
    const args = buildCodexMiddlewareArgs(
      {
        agentId: "agent",
        provider: "codex",
        purpose: "status",
        workspacePath: "/tmp/workspace",
        runtimePrompt: "Return status",
        persistedSummary: "Status",
        sessionId: "thread-123",
        sessionMode: "continue",
        sandboxMode: "read-only",
        networkMode: "default",
        outputSchemaName: "status.schema.json",
        correlationId: "corr-1",
        maxTurns: 2,
      },
      "/tmp/status.schema.json",
    );
    expect(args).toContain("read-only");
    expect(args).toContain("--output-schema");
    expect(args).toContain("/tmp/status.schema.json");
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "-"]);
    expect(args).not.toContain("Return status");
    expect(args).not.toContain("danger-full-access");
  });

  it("passes an explicit model to structured middleware runs", () => {
    const args = buildCodexMiddlewareArgs(
      {
        agentId: "agent",
        provider: "codex",
        purpose: "status",
        workspacePath: "/tmp/workspace",
        runtimePrompt: "Return status",
        persistedSummary: "Status",
        sessionMode: "ephemeral",
        sandboxMode: "read-only",
        networkMode: "none",
        outputSchemaName: "status.schema.json",
        correlationId: "corr-model",
        maxTurns: 1,
      },
      "/tmp/status.schema.json",
      "/tmp/workspace",
      "gpt-5.5",
    );

    expect(args).toContain("--model");
    expect(args).toContain("gpt-5.5");
  });

  it("does not spawn Codex when cancellation arrives during schema preflight", async () => {
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const blockedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const spawn = vi.fn();
    const remove = vi.fn(async () => undefined);
    const runner = new CodexRunner(
      loadConfig({ NODE_ENV: "test" }),
      {
        mkdtemp: (async () => "D:\\temporary\\telaegent-schema") as CodexRunnerDependencies["mkdtemp"],
        writeFile: (async () => {
          markWriteStarted();
          await blockedWrite;
        }) as CodexRunnerDependencies["writeFile"],
        rm: remove as CodexRunnerDependencies["rm"],
        spawn: spawn as unknown as CodexRunnerDependencies["spawn"],
      },
    );
    const controller = new AbortController();
    const running = runner.runStructured(
      {
        agentId: "binding-a",
        provider: "codex",
        purpose: "sender_draft",
        workspacePath: "D:\\workspace\\repo",
        runtimePrompt: "Prepare a private draft",
        persistedSummary: "Approved context",
        sessionMode: "ephemeral",
        sandboxMode: "read-only",
        networkMode: "none",
        outputSchemaName: "sender-turn.schema.json",
        correlationId: "draft-1",
        maxTurns: 1,
      },
      { type: "object" },
      undefined,
      controller.signal,
    );

    await writeStarted;
    controller.abort();
    releaseWrite();

    await expect(running).rejects.toBeInstanceOf(RunCancelledError);
    expect(spawn).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
  });
});
