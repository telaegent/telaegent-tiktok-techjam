import { describe, expect, it, vi } from "vitest";
import {
  CodexRunner,
  buildCodexArgs,
  buildCodexChildEnvironment,
  buildCodexMiddlewareArgs,
  closedToolSurface,
  codexProcessFailed,
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
      "--ignore-user-config",
      ...(process.platform === "win32"
        ? ["-c", "windows.sandbox=unelevated"]
        : []),
      "-c",
      "mcp_servers={}",
      "-c",
      "notify=[]",
      "-c",
      'web_search="disabled"',
      "-c",
      'model_reasoning_effort="medium"',
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

  it("treats a parsed turn failure as authoritative even when Codex exits zero", () => {
    const parsed = {
      messages: ["Partial response must not be accepted"],
      threadId: "thread-123" as string | null,
      usage: null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.failed",
        error: { message: "provider rejected the turn" },
      }),
      parsed,
    );

    expect(parsed.errors).toEqual(["provider rejected the turn"]);
    expect(codexProcessFailed(0, parsed)).toBe(true);
  });

  it("captures terminal error items emitted by current Codex JSONL", () => {
    const parsed = {
      messages: [] as string[],
      threadId: "thread-123" as string | null,
      usage: null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "error", message: "model is unavailable" },
      }),
      parsed,
    );

    expect(parsed.errors).toEqual(["model is unavailable"]);
    expect(codexProcessFailed(1, parsed)).toBe(true);
  });

  it("accepts a clean zero-exit Codex process", () => {
    expect(codexProcessFailed(0, { errors: [] })).toBe(false);
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

  it("keeps the owner's personal config out of a Telaegent run", () => {
    // Dropping `--ignore-user-config` does fix reading, and that is how this
    // was first "solved". It is not sound: with the config loaded, a turn
    // billed to the user as read-only reached the network and returned a live
    // GitHub API value. `--sandbox` binds the shell, not the model's own
    // tools, and `mcp_servers={}` leaves built-ins, plugins, marketplaces and
    // `shell_environment_policy` untouched. Ignore the file; grant back only
    // what the run needs, by name.
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
        correlationId: "corr-config",
        maxTurns: 1,
      },
      "/tmp/status.schema.json",
    );

    expect(args).toContain("--ignore-user-config");
    // Codex has no native read tool; its only file access is spawning a shell.
    // `--ignore-user-config` discards `[windows] sandbox`, and without a
    // replacement every command returns `rejected: blocked by policy`, so the
    // model answers from nothing. Granting the key back is what keeps it able
    // to read at all.
    expect(closedToolSurface("win32")).toContain("windows.sandbox=unelevated");
    expect(closedToolSurface("darwin")).not.toContain(
      "windows.sandbox=unelevated",
    );
  });

  it("closes the model's own network egress, not just the shell's", () => {
    // Verified by behaviour: with the config loaded, or with only
    // `tools.web_search=false` set, a read-only turn still fetched a live
    // value from api.github.com. `-c` accepts unknown keys silently, so
    // `tools.web_search=false` is taken and does nothing. This is the key that
    // actually closes it -- do not swap it for one that merely parses.
    expect(closedToolSurface("win32")).toContain('web_search="disabled"');
    expect(closedToolSurface("win32")).not.toContain("tools.web_search=false");
  });

  it("pins reasoning effort that ignoring the config would otherwise drop", () => {
    // Without the user's config the effort defaults to `none`. Nothing fails;
    // every turn just gets shallower, which is the failure this whole runner
    // exists to prevent.
    expect(closedToolSurface("win32")).toContain(
      'model_reasoning_effort="medium"',
    );
  });

  it("closes the tool surface the user's config would otherwise carry in", () => {
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
        correlationId: "corr-surface",
        maxTurns: 1,
      },
      "/tmp/status.schema.json",
    );

    // The owner's own MCP servers and per-turn notify hook reach outside the
    // workspace. Reading their config must not import their tools.
    expect(args).toContain("mcp_servers={}");
    expect(args).toContain("notify=[]");
    // Containment still comes from the sandbox, not from ignoring the config.
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    expect(args).toContain('approval_policy="never"');
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

describe("Codex child environment", () => {
  const config = { codexHome: "D:\telaegent\codex-home", codexApiKey: "" };

  it("forwards operator-supplied Codex variables to the CLI", () => {
    const environment = buildCodexChildEnvironment(config, {
      CODEX_CA_CERTIFICATE: "/etc/corp/ca.pem",
      CODEX_ACCESS_TOKEN: "token",
      CODEX_SQLITE_HOME: "/var/codex/sqlite",
      CODEX_WORKLOAD_IDENTITY_PROVIDER: "gcp://project/pool",
    });
    expect(environment.CODEX_CA_CERTIFICATE).toBe("/etc/corp/ca.pem");
    expect(environment.CODEX_ACCESS_TOKEN).toBe("token");
    expect(environment.CODEX_SQLITE_HOME).toBe("/var/codex/sqlite");
    expect(environment.CODEX_WORKLOAD_IDENTITY_PROVIDER).toBe("gcp://project/pool");
  });

  it("keeps CODEX_HOME under Telaegent control", () => {
    const environment = buildCodexChildEnvironment(config, {
      CODEX_HOME: "D:\attacker\home",
    });
    expect(environment.CODEX_HOME).toBe("D:\telaegent\codex-home");
  });

  it("resolves the API key from configuration rather than the ambient value", () => {
    expect(
      buildCodexChildEnvironment({ ...config, codexApiKey: "configured" }, {
        CODEX_API_KEY: "ambient",
      }).CODEX_API_KEY,
    ).toBe("configured");
    expect(
      buildCodexChildEnvironment(config, { CODEX_API_KEY: "ambient" }).CODEX_API_KEY,
    ).toBeUndefined();
  });

  it("still withholds unrelated host variables", () => {
    const environment = buildCodexChildEnvironment(config, {
      PATH: "/usr/bin",
      AWS_SECRET_ACCESS_KEY: "secret",
      SUPABASE_SERVICE_ROLE_KEY: "secret",
    });
    expect(environment.PATH).toBe("/usr/bin");
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(environment.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });

  it("preserves the existing proxy and trust-store allowlist", () => {
    const environment = buildCodexChildEnvironment(config, {
      HTTPS_PROXY: "http://proxy.corp:8080",
      NODE_EXTRA_CA_CERTS: "/etc/corp/ca.pem",
      SSL_CERT_FILE: "/etc/corp/bundle.pem",
    });
    expect(environment.HTTPS_PROXY).toBe("http://proxy.corp:8080");
    expect(environment.NODE_EXTRA_CA_CERTS).toBe("/etc/corp/ca.pem");
    expect(environment.SSL_CERT_FILE).toBe("/etc/corp/bundle.pem");
  });

  it("preserves Windows profile locations required by the native CLI", () => {
    const environment = buildCodexChildEnvironment(config, {
      USERPROFILE: "C:\\Users\\developer",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\developer",
      APPDATA: "C:\\Users\\developer\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\developer\\AppData\\Local",
    });
    expect(environment.USERPROFILE).toBe("C:\\Users\\developer");
    expect(environment.HOMEDRIVE).toBe("C:");
    expect(environment.HOMEPATH).toBe("\\Users\\developer");
    expect(environment.APPDATA).toBe("C:\\Users\\developer\\AppData\\Roaming");
    expect(environment.LOCALAPPDATA).toBe(
      "C:\\Users\\developer\\AppData\\Local",
    );
  });
});
