import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

/** A middleware request shaped like the drafting pass, which declares no tools. */
function noToolsRequest() {
  return {
    agentId: "binding-a",
    provider: "codex" as const,
    purpose: "sender_draft" as const,
    workspacePath: "D:\\workspace\\repo",
    runtimePrompt: "Draft from the note",
    persistedSummary: "Approved context",
    sessionMode: "ephemeral" as const,
    sandboxMode: "read-only" as const,
    networkMode: "none" as const,
    outputSchemaName: "sender-turn.schema.json",
    correlationId: "draft-no-tools",
    maxTurns: 1,
    toolMode: "none" as const,
  };
}

/**
 * A Codex child that emits the given JSONL and then closes.
 *
 * `pid` is absent on purpose: process-tree termination cannot reach a child
 * that never had one, so it falls back to `kill`, which this closes on. That
 * is the same ordering a real killed CLI produces -- exit before termination
 * verification settles -- without signalling anything on the host.
 */
function fakeCodexProcess(events: unknown[]) {
  const listeners = new Map<string, ((...values: unknown[]) => void)[]>();
  const on = (name: string, listener: (...values: unknown[]) => void) => {
    listeners.set(name, [...(listeners.get(name) ?? []), listener]);
  };
  const emit = (name: string, ...values: unknown[]) => {
    for (const listener of listeners.get(name) ?? []) listener(...values);
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    emit("close", 0);
  };
  const child = {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stdin: { on: () => undefined, end: () => undefined },
    stdout: { on: (name: string, listener: (...values: unknown[]) => void) => on("stdout:" + name, listener) },
    stderr: { on: () => undefined },
    once: on,
    on,
    kill: () => {
      close();
      return true;
    },
  };
  queueMicrotask(() => {
    for (const event of events) {
      emit("stdout:data", Buffer.from(JSON.stringify(event) + "\n", "utf8"));
    }
    close();
  });
  return child;
}

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
      "--strict-config",
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

  it("refuses every tool surface Codex reports in a turn that declared none", () => {
    // The refusal is defined by `codexActivity`, so this list is the same one
    // the progress feed labels. A Codex release that adds a tool type earns an
    // activity label first, and inherits the refusal with it.
    for (const itemType of [
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "web_search",
    ]) {
      for (const eventType of ["item.started", "item.completed"]) {
        const parsed = {
          messages: [] as string[],
          threadId: null as string | null,
          usage: null,
          errors: [] as string[],
        };
        expect(() =>
          parseCodexEventLine(
            JSON.stringify({ type: eventType, item: { type: itemType } }),
            parsed,
            undefined,
            true,
          ),
        ).toThrow("used a tool in a turn that declared none");
      }
    }
  });

  it("still reads session, message and usage events in a turn that declared none", () => {
    // A refusal that fired on ordinary events would end every toolless turn,
    // which is the failure mode this guard has to avoid to be shippable.
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
    };
    for (const event of [
      { type: "thread.started", thread_id: "thread-quiet" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: "{}" } },
      { type: "item.completed", item: { type: "reasoning" } },
      { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } },
    ]) {
      expect(() =>
        parseCodexEventLine(JSON.stringify(event), parsed, undefined, true),
      ).not.toThrow();
    }
    expect(parsed.threadId).toBe("thread-quiet");
    expect(parsed.messages).toEqual(["{}"]);
  });

  it("leaves a tool-using turn alone when the caller allowed tools", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
    };
    expect(() =>
      parseCodexEventLine(
        JSON.stringify({
          type: "item.started",
          item: { type: "command_execution" },
        }),
        parsed,
      ),
    ).not.toThrow();
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

  it("names a model only when one is supplied", () => {
    const base = {
      agentId: "agent",
      provider: "codex",
      purpose: "status",
      workspacePath: "/tmp/workspace",
      runtimePrompt: "Return status",
      persistedSummary: "Status",
      sessionMode: "fresh",
      sandboxMode: "read-only",
      networkMode: "none",
      outputSchemaName: "status.schema.json",
      correlationId: "corr-1",
      maxTurns: 2,
    } as const;

    // No model means the connector's own CODEX_MODEL, or the CLI default.
    expect(
      buildCodexMiddlewareArgs(base, "/tmp/status.schema.json"),
    ).not.toContain("--model");

    const args = buildCodexMiddlewareArgs(
      base,
      "/tmp/status.schema.json",
      base.workspacePath,
      "gpt-5.6-luna",
    );
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-luna");
    // `--ignore-user-config` is what makes this the only model input the CLI
    // sees. If it ever leaves the surface, the flag stops being authoritative.
    expect(args).toContain("--ignore-user-config");
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
    // A `-c` key Codex no longer knows is accepted in silence, which turns a
    // dropped policy into a policy that looks applied. This makes it a startup
    // error instead; every key above is recognised by the pinned CLI.
    expect(args).toContain("--strict-config");
    // Containment still comes from the sandbox, not from ignoring the config.
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    expect(args).toContain('approval_policy="never"');
  });

  it("points a turn that declared no tools away from the repository", async () => {
    const spawnCodex = vi.fn(() =>
      fakeCodexProcess([
        { type: "item.completed", item: { type: "agent_message", text: "{}" } },
      ]),
    );
    const removed: string[] = [];
    const written = vi.fn(async () => undefined);
    const runner = new CodexRunner(loadConfig({ NODE_ENV: "test" }), {
      mkdtemp: (async (prefix: string) => prefix + "made") as CodexRunnerDependencies["mkdtemp"],
      writeFile: written as unknown as CodexRunnerDependencies["writeFile"],
      rm: (async (target: string) => {
        removed.push(target);
      }) as CodexRunnerDependencies["rm"],
      spawn: spawnCodex as unknown as CodexRunnerDependencies["spawn"],
    });

    await runner.runStructured(noToolsRequest(), { type: "object" });

    const [, args, options] = spawnCodex.mock.calls[0] as [
      string,
      string[],
      { cwd: string },
    ];
    // The repository is not the working directory, is not the `-C` root, and
    // is not spelled anywhere in argv the model could read back.
    expect(options.cwd).not.toBe("D:\\workspace\\repo");
    expect(args).not.toContain("D:\\workspace\\repo");
    expect(args[args.indexOf("-C") + 1]).toContain("telagent-notools-");
    // And it is removed, like the schema directory beside it.
    expect(removed.some((target) => target.includes("telagent-notools-"))).toBe(true);
    // The empty directory carries a turn policy, because a model that arrives
    // expecting a repository and finds none goes looking for one. Measured:
    // this is the difference between a declined answer and a spawned shell.
    const notice = written.mock.calls.find(([target]) =>
      String(target).endsWith("AGENTS.md"),
    );
    expect(notice?.[0]).toContain("telagent-notools-");
    expect(String(notice?.[1])).toContain("This turn has no tools.");
  });

  it("kills a turn that declared no tools rather than answering from one", async () => {
    // A real child, because the refusal has to survive the runner's own
    // cleanup: an unverified process-tree termination replaces the thrown
    // error, so a stub that cannot be killed would pass for the wrong reason.
    // This one keeps running until it is killed, which is also the point --
    // the model is stopped mid-turn, not asked to finish politely.
    const emitted = [
      { type: "thread.started", thread_id: "thread-x" },
      { type: "item.started", item: { type: "command_execution" } },
      {
        type: "item.completed",
        item: { type: "agent_message", text: '{"answered":true}' },
      },
    ];
    const script =
      "for (const event of " +
      JSON.stringify(emitted) +
      ') process.stdout.write(JSON.stringify(event) + "\\n");' +
      "setInterval(() => {}, 1000);";
    const runner = new CodexRunner(loadConfig({ NODE_ENV: "test" }), {
      mkdtemp,
      writeFile,
      rm,
      spawn: ((_bin: string, _args: string[], options: object) =>
        spawn(process.execPath, ["-e", script], options)) as unknown as
        CodexRunnerDependencies["spawn"],
    });

    // The message after the tool call is the whole point: it never becomes a
    // result. The turn fails instead of returning an answer assembled from
    // something the caller said it could not read.
    await expect(
      runner.runStructured(noToolsRequest(), { type: "object" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_RUNTIME_POLICY",
      localDiagnostic: { phase: "event_stream" },
    });
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
