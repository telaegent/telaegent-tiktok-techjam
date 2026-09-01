import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import type {
  JsonSchemaDocument,
  MiddlewareProviderRunner,
  LocalMiddlewareRunRequest,
  NormalizedRunResult,
  RuntimeProviderCapability,
  RuntimeActivity,
  RuntimeProgressEvent,
  RuntimeProgressSink,
} from "./runtime-contract.js";
import {
  RuntimeProviderError,
  classifyProviderFailure,
  providerFailureDetail,
} from "./runtime-errors.js";
import { RuntimeWatchdog } from "./runtime-watchdog.js";
import {
  onRuntimeCancellation,
  throwIfRuntimeCancelled,
} from "./runtime-cancellation.js";
import { providerCompatibleSchema } from "./provider-output-schema.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

/** A provider failure event is authoritative even when the CLI exits zero. */
export function codexProcessFailed(
  exitCode: number,
  parsed: Readonly<Pick<ParsedEvents, "errors">>,
): boolean {
  return exitCode !== 0 || parsed.errors.length > 0;
}

function emitProgress(
  onProgress: RuntimeProgressSink | undefined,
  event: RuntimeProgressEvent,
): void {
  try {
    onProgress?.(event);
  } catch {
    // UI progress is best-effort and must never fail the provider run.
  }
}

function codexActivity(itemType: unknown): RuntimeActivity | null {
  switch (itemType) {
    case "command_execution":
      return "command";
    case "file_change":
      return "file_change";
    case "mcp_tool_call":
      return "mcp";
    case "web_search":
      return "web_search";
    default:
      return null;
  }
}

interface ActiveCodexProcess {
  child: ChildProcess;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  settled: Promise<void>;
  forceKillTimer: NodeJS.Timeout | null;
}

interface CodexProcessRequest {
  agentId: string;
  workspacePath: string;
  threadId: string | null;
  args: string[];
}

interface CodexProcessResult extends RunnerResult {
  exitCode: number;
  durationMs: number;
}

export interface CodexRunnerDependencies {
  mkdtemp: typeof mkdtemp;
  writeFile: typeof writeFile;
  rm: typeof rm;
  spawn: typeof spawn;
}

const defaultDependencies: CodexRunnerDependencies = {
  mkdtemp,
  writeFile,
  rm,
  spawn,
};

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
  model = "",
): string[] {
  const args = [
    "exec",
    // Keep Telaegent runs independent from a developer's personal model and
    // provider settings. Authentication and Telaegent-owned sessions still
    // come from CODEX_HOME; an explicit CODEX_MODEL below remains supported.
    // This also prevents an older CLI from inheriting a newer app's default
    // model and failing before the first turn starts.
    "--ignore-user-config",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  if (model) args.push("--model", model);
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

export function buildCodexMiddlewareArgs(
  request: LocalMiddlewareRunRequest,
  outputSchemaPath: string,
  workspacePath = request.workspacePath,
  model = "",
): string[] {
  const args = [
    "exec",
    // Reuse CODEX_HOME for local authentication/session state, but do not
    // inherit unrelated personal model/provider configuration. CODEX_MODEL,
    // when explicitly configured for Telaegent, is added below and wins.
    "--ignore-user-config",
    "--json",
    "-c",
    'approval_policy="never"',
    "--sandbox",
    request.sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
    "--output-schema",
    outputSchemaPath,
  ];
  if (model) args.push("--model", model);
  if (request.sandboxMode === "workspace-write") {
    args.push(
      "-c",
      "sandbox_workspace_write.network_access=" +
        (request.networkMode === "default" ? "true" : "false"),
    );
  }
  if (request.sessionMode === "ephemeral") args.push("--ephemeral");
  if (request.sessionMode === "continue" && request.sessionId) {
    args.push("resume", request.sessionId, "-");
  } else {
    args.push("-");
  }
  return args;
}

export function parseCodexEventLine(
  line: string,
  parsed: ParsedEvents,
  onProgress?: RuntimeProgressSink,
): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new RuntimeProviderError(
      "INVALID_AGENT_OUTPUT",
      "Codex returned an invalid event stream",
    );
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
    emitProgress(onProgress, {
      type: "session_started",
      provider: "codex",
    });
  }
  if (event.type === "turn.started") {
    emitProgress(onProgress, { type: "turn_started", provider: "codex" });
  }
  if (event.type === "item.started" && event.item && typeof event.item === "object") {
    const activity = codexActivity((event.item as Record<string, unknown>).type);
    if (activity) {
      emitProgress(onProgress, {
        type: "activity_started",
        provider: "codex",
        activity,
      });
    }
  }
  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
      emitProgress(onProgress, {
        type: "text_delta",
        provider: "codex",
        text: item.text,
      });
    } else if (item.type === "error" && typeof item.message === "string") {
      // Recent Codex CLIs can report the terminal cause only as an error item,
      // without a top-level `error` or `turn.failed` event. Keep it local for
      // classification; safeRuntimeError prevents raw text leaving the device.
      parsed.errors.push(item.message);
    } else {
      const activity = codexActivity(item.type);
      if (activity) {
        emitProgress(onProgress, {
          type: "activity_completed",
          provider: "codex",
          activity,
        });
      }
    }
  }
  if (event.type === "turn.completed") {
    if (event.usage && typeof event.usage === "object") {
      const usage = event.usage as Record<string, unknown>;
      parsed.usage = {
        ...(typeof usage.input_tokens === "number"
          ? { inputTokens: usage.input_tokens }
          : {}),
        ...(typeof usage.cached_input_tokens === "number"
          ? { cachedInputTokens: usage.cached_input_tokens }
          : {}),
        ...(typeof usage.output_tokens === "number"
          ? { outputTokens: usage.output_tokens }
          : {}),
      };
    }
    emitProgress(onProgress, { type: "turn_completed", provider: "codex" });
  }
  if (event.type === "error" || event.type === "turn.failed") {
    const nestedError =
      event.error && typeof event.error === "object"
        ? (event.error as Record<string, unknown>)
        : null;
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : nestedError && typeof nestedError.message === "string"
            ? nestedError.message
          : "Codex reported an unknown error";
    parsed.errors.push(message);
  }
}

/** Codex variables Telaegent derives from its own configuration. */
const managedCodexVariables = new Set(["CODEX_HOME", "CODEX_API_KEY"]);

/** Host variables the CLI needs that carry no Telaegent secrets. */
const inheritedVariableNames = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "TERM",
] as const;

/**
 * Builds the environment Codex is spawned with. Every operator-supplied CODEX_*
 * variable is forwarded, so a CLI that works in their terminal keeps working
 * here: CODEX_CA_CERTIFICATE is the only trust anchor the Rust client reads on
 * an intercepted network, and the workload-identity and CODEX_SQLITE_HOME
 * settings reach the CLI through no other channel. CODEX_HOME stays
 * Telaegent-owned because it is the sandbox this process writes config.toml
 * into, and the API key arrives through AppConfig, which already sources it
 * from the environment.
 */
export function buildCodexChildEnvironment(
  config: Pick<AppConfig, "codexHome" | "codexApiKey">,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CODEX_HOME: config.codexHome,
    NO_COLOR: "1",
  };
  for (const name of inheritedVariableNames) {
    if (parentEnv[name] !== undefined) environment[name] = parentEnv[name];
  }
  for (const [name, value] of Object.entries(parentEnv)) {
    if (!name.startsWith("CODEX_")) continue;
    if (managedCodexVariables.has(name)) continue;
    if (value !== undefined) environment[name] = value;
  }
  if (config.codexApiKey) {
    environment.CODEX_API_KEY = config.codexApiKey;
  }
  return environment;
}

export class CodexRunner implements AgentRunner, MiddlewareProviderRunner {
  readonly provider = "codex" as const;
  private readonly active = new Map<string, ActiveCodexProcess>();

  private readonly dependencies: CodexRunnerDependencies;

  constructor(
    private readonly config: AppConfig,
    dependencies: Partial<CodexRunnerDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async capability(): Promise<RuntimeProviderCapability> {
    const installed = await this.isAvailable();
    if (!installed) {
      return { installed: false, authenticated: false, reason: "not_installed" };
    }
    if (this.config.codexApiKey) {
      return { installed: true, authenticated: true, reason: null };
    }
    try {
      await execFileAsync(this.config.codexBin, ["login", "status"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return { installed: true, authenticated: true, reason: null };
    } catch {
      return {
        installed: true,
        authenticated: false,
        reason: "not_authenticated",
      };
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) return false;
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const result = await this.runProcess({
      agentId: request.agentId,
      workspacePath: request.workspacePath,
      threadId: request.threadId,
      args: buildCodexArgs(
        request,
        this.config.codexSandboxMode,
        request.workspacePath,
        this.config.codexModel,
      ),
    });
    return { output: result.output, threadId: result.threadId, usage: result.usage };
  }

  async runStructured(
    request: LocalMiddlewareRunRequest,
    outputSchema: JsonSchemaDocument,
    onProgress?: RuntimeProgressSink,
    signal?: AbortSignal,
  ): Promise<NormalizedRunResult> {
    throwIfRuntimeCancelled(signal);
    const schemaDirectory = await this.dependencies.mkdtemp(
      path.join(tmpdir(), "telagent-schema-"),
    );
    const schemaPath = path.join(schemaDirectory, "output.schema.json");
    try {
      throwIfRuntimeCancelled(signal);
      await this.dependencies.writeFile(
        schemaPath,
        JSON.stringify(providerCompatibleSchema("codex", outputSchema)),
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
      throwIfRuntimeCancelled(signal);
      const result = await this.runProcess(
        {
          agentId: request.agentId,
          workspacePath: request.workspacePath,
          threadId:
            request.sessionMode === "continue" ? request.sessionId ?? null : null,
          args: buildCodexMiddlewareArgs(
            request,
            schemaPath,
            request.workspacePath,
            this.config.codexModel,
          ),
        },
        request.runtimePrompt,
        onProgress,
        signal,
      );
      let final: unknown;
      try {
        final = JSON.parse(result.output) as unknown;
      } catch {
        throw new RuntimeProviderError(
          "INVALID_AGENT_OUTPUT",
          "Codex completed without structured output",
          { phase: "structured_output", exitCode: result.exitCode },
        );
      }
      return {
        provider: "codex",
        ...(request.sessionMode !== "ephemeral" && result.threadId
          ? { sessionId: result.threadId }
          : {}),
        final,
        changedFiles: [],
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      };
    } finally {
      await this.dependencies.rm(schemaDirectory, { recursive: true, force: true });
    }
  }

  private async runProcess(
    request: CodexProcessRequest,
    stdinPayload?: string,
    onProgress?: RuntimeProgressSink,
    signal?: AbortSignal,
  ): Promise<CodexProcessResult> {
    throwIfRuntimeCancelled(signal);
    if (this.active.has(request.agentId)) {
      throw new RuntimeProviderError(
        "RUNTIME_FAILED",
        "Agent runtime is already active",
        { phase: "concurrency" },
      );
    }
    const startedAt = Date.now();
    const child = this.dependencies.spawn(this.config.codexBin, request.args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(),
      stdio: [stdinPayload === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: false,
    });
    if (stdinPayload !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdinPayload);
    }
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active: ActiveCodexProcess = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null,
    };
    this.active.set(request.agentId, active);
    const removeCancellationListener = onRuntimeCancellation(signal, () => {
      active.cancelled = true;
      this.terminate(active);
    });
    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let parseFailure: RuntimeProviderError | null = null;

    const watchdog = new RuntimeWatchdog(
      this.config.runtimeIdleTimeoutMs,
      this.config.codexTimeoutMs,
      () => {
        active.timedOut = true;
        this.terminate(active);
      },
    );

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      watchdog.activity();
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          try {
            parseCodexEventLine(line, parsed, onProgress);
          } catch (error) {
            parseFailure = error as RuntimeProviderError;
            this.terminate(active);
            return;
          }
        }
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    try {
      let exitCode: number;
      try {
        exitCode = await new Promise<number>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => resolve(code ?? 1));
        });
      } catch (error) {
        throw classifyProviderFailure("codex", error, { phase: "spawn" });
      }
      if (stdout.trim() && !parseFailure) {
        parseCodexEventLine(stdout.trim(), parsed, onProgress);
      }
      if (active.cancelled) throw new RunCancelledError();
      if (active.timedOut) {
        throw new RuntimeProviderError(
          "RUNTIME_TIMEOUT",
          "Codex runtime timed out",
          { phase: "timeout" },
        );
      }
      if (active.outputExceeded) {
        throw new RuntimeProviderError(
          "RUNTIME_OUTPUT_LIMIT",
          "Codex output exceeded the configured limit",
          { phase: "output_limit" },
        );
      }
      if (parseFailure) {
        const failure = parseFailure as RuntimeProviderError;
        throw new RuntimeProviderError(failure.code, failure.message, {
          phase: "event_stream",
          exitCode,
        });
      }
      if (codexProcessFailed(exitCode, parsed)) {
        const detail = providerFailureDetail(parsed.errors, stderr);
        throw classifyProviderFailure(
          "codex",
          detail.length > 0 ? detail : "provider failure",
          { phase: "provider_exit", exitCode },
        );
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new RuntimeProviderError(
          "INVALID_AGENT_OUTPUT",
          "Codex completed without an agent message",
          { phase: "structured_output", exitCode },
        );
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
        exitCode,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      removeCancellationListener();
      watchdog.stop();
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private terminate(active: ActiveCodexProcess): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    return buildCodexChildEnvironment(this.config);
  }
}
