import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import type {
  JsonSchemaDocument,
  MiddlewareProviderRunner,
  LocalMiddlewareRunRequest,
  NormalizedRunResult,
  RuntimeProviderCapability,
  RuntimeProgressEvent,
  RuntimeProgressSink,
} from "./runtime-contract.js";
import {
  RuntimeProviderError,
  classifyProviderFailure,
  type LocalRuntimeFailureDiagnostic,
} from "./runtime-errors.js";
import { RuntimeWatchdog } from "./runtime-watchdog.js";
import {
  onRuntimeCancellation,
  throwIfRuntimeCancelled,
} from "./runtime-cancellation.js";

const execFileAsync = promisify(execFile);

export interface ParsedClaudeEvents {
  sessionId: string | null;
  structuredOutput: unknown;
  resultText: string | null;
  resultSubtype: string | null;
  errors: string[];
}

/**
 * Older Claude Code releases can emit a valid structured object and then keep
 * calling StructuredOutput until the turn budget is exhausted. The object is
 * still passed through Telaegent's strict protocol parser and security guard,
 * so retaining it for this one known terminal subtype is safe.
 */
export function completedStructuredOutputBeforeMaxTurns(
  parsed: Readonly<ParsedClaudeEvents>,
): boolean {
  return (
    parsed.structuredOutput !== undefined && parsed.resultSubtype === "error_max_turns"
  );
}

export function buildClaudeArgs(
  request: LocalMiddlewareRunRequest,
  outputSchema: JsonSchemaDocument,
): string[] {
  if (request.networkMode === "none" && request.sandboxMode === "workspace-write") {
    throw new RuntimeProviderError(
      "UNSUPPORTED_RUNTIME_POLICY",
      "Claude Code cannot guarantee network isolation for a writable local run",
    );
  }

  const readOnly = request.sandboxMode === "read-only";
  const tools = readOnly
    ? "Read,Glob,Grep"
    : "Read,Glob,Grep,Edit,Write,Bash";
  const disallowedTools = readOnly
    ? "Bash,PowerShell,Edit,Write,WebFetch,WebSearch,Task"
    : "WebFetch,WebSearch,Task";
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--json-schema",
    JSON.stringify(outputSchema),
    "--max-turns",
    String(request.maxTurns),
    "--permission-mode",
    readOnly ? "plan" : "acceptEdits",
    "--tools",
    tools,
    "--allowedTools",
    tools,
    "--disallowedTools",
    disallowedTools,
    "--restricted",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-chrome",
    "--prompt-suggestions",
    "false",
  ];
  if (request.sessionMode === "continue" && request.sessionId) {
    args.push("--resume", request.sessionId);
  }
  if (request.sessionMode === "ephemeral") {
    args.push("--no-session-persistence");
  }
  return args;
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

export function parseClaudeStreamLine(
  line: string,
  parsed: ParsedClaudeEvents,
  onProgress?: RuntimeProgressSink,
): void {
  if (!line.trim()) return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new RuntimeProviderError(
      "INVALID_AGENT_OUTPUT",
      "Claude Code returned an invalid event stream",
    );
  }

  if (
    typeof event.session_id === "string" &&
    event.session_id !== parsed.sessionId
  ) {
    parsed.sessionId = event.session_id;
    emitProgress(onProgress, {
      type: "session_started",
      provider: "claude",
    });
  }

  if (event.type === "system" && event.subtype === "api_retry") {
    emitProgress(onProgress, {
      type: "retrying",
      provider: "claude",
      attempt: typeof event.attempt === "number" ? event.attempt : 1,
      maxRetries:
        typeof event.max_retries === "number" ? event.max_retries : 1,
      retryDelayMs:
        typeof event.retry_delay_ms === "number" ? event.retry_delay_ms : 0,
    });
  }

  if (event.type === "stream_event" && event.event && typeof event.event === "object") {
    const streamEvent = event.event as Record<string, unknown>;
    if (streamEvent.type === "message_start") {
      emitProgress(onProgress, { type: "turn_started", provider: "claude" });
    }
    if (
      streamEvent.type === "content_block_delta" &&
      streamEvent.delta &&
      typeof streamEvent.delta === "object"
    ) {
      const delta = streamEvent.delta as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        emitProgress(onProgress, {
          type: "text_delta",
          provider: "claude",
          text: delta.text,
        });
      }
    }
  }
  if (event.type !== "result") return;

  if (typeof event.subtype === "string") {
    parsed.resultSubtype = event.subtype;
  }

  if (event.structured_output !== undefined) {
    parsed.structuredOutput = event.structured_output;
  }
  if (typeof event.result === "string") {
    parsed.resultText = event.result;
  }
  if (event.is_error === true) {
    const eventErrors = Array.isArray(event.errors)
      ? event.errors
          .filter(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          )
          .slice(-8)
          .map((value) => value.slice(-16_384))
      : [];
    if (typeof event.result === "string" && event.result.trim().length > 0) {
      parsed.errors.push(event.result.slice(-16_384));
    } else if (eventErrors.length > 0) {
      parsed.errors.push(...eventErrors);
    } else {
      parsed.errors.push("Claude Code reported an error");
    }
  }
  emitProgress(onProgress, { type: "turn_completed", provider: "claude" });
}

export function extractClaudeFinalResult(parsed: ParsedClaudeEvents): unknown {
  if (parsed.structuredOutput !== undefined) return parsed.structuredOutput;
  if (parsed.resultText) {
    try {
      return JSON.parse(parsed.resultText) as unknown;
    } catch {
      // Fall through to the stable error below.
    }
  }
  throw new RuntimeProviderError(
    "INVALID_AGENT_OUTPUT",
    "Claude Code completed without structured output",
  );
}

export function classifyClaudeFailure(
  detail: unknown,
  localDiagnostic?: Readonly<LocalRuntimeFailureDiagnostic>,
): RuntimeProviderError {
  return classifyProviderFailure("claude", detail, localDiagnostic);
}

interface ActiveClaudeProcess {
  child: ChildProcess;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  settled: Promise<void>;
  forceKillTimer: NodeJS.Timeout | null;
}

export class ClaudeCodeRunner implements MiddlewareProviderRunner {
  readonly provider = "claude" as const;
  private readonly active = new Map<string, ActiveClaudeProcess>();

  constructor(private readonly config: AppConfig) {}

  async capability(): Promise<RuntimeProviderCapability> {
    try {
      await execFileAsync(this.config.claudeBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
    } catch {
      return { installed: false, authenticated: false, reason: "not_installed" };
    }
    if (this.config.claudeApiKey) {
      return { installed: true, authenticated: true, reason: null };
    }
    try {
      const { stdout } = await execFileAsync(
        this.config.claudeBin,
        ["auth", "status", "--json"],
        { timeout: 5_000, env: this.childEnvironment(), encoding: "utf8" },
      );
      const status = JSON.parse(String(stdout)) as { loggedIn?: unknown };
      return status.loggedIn === true
        ? { installed: true, authenticated: true, reason: null }
        : { installed: true, authenticated: false, reason: "not_authenticated" };
    } catch {
      return { installed: true, authenticated: false, reason: "probe_failed" };
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

  async runStructured(
    request: LocalMiddlewareRunRequest,
    outputSchema: JsonSchemaDocument,
    onProgress?: RuntimeProgressSink,
    signal?: AbortSignal,
  ): Promise<NormalizedRunResult> {
    throwIfRuntimeCancelled(signal);
    if (this.active.has(request.agentId)) {
      throw new RuntimeProviderError(
        "RUNTIME_FAILED",
        "Agent runtime is already active",
        { phase: "concurrency" },
      );
    }
    const startedAt = Date.now();
    const child = spawn(this.config.claudeBin, buildClaudeArgs(request, outputSchema), {
      cwd: request.workspacePath,
      env: this.childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(request.runtimePrompt);
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active: ActiveClaudeProcess = {
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

    const parsed: ParsedClaudeEvents = {
      sessionId: request.sessionMode === "continue" ? request.sessionId ?? null : null,
      structuredOutput: undefined,
      resultText: null,
      resultSubtype: null,
      errors: [],
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let parseFailure: RuntimeProviderError | null = null;

    const watchdog = new RuntimeWatchdog(
      this.config.runtimeIdleTimeoutMs,
      this.config.claudeTimeoutMs,
      () => {
        active.timedOut = true;
        this.terminate(active);
      },
    );

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      watchdog.activity();
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.claudeMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stderr") {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
        return;
      }
      stdout += chunk.toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          parseClaudeStreamLine(line, parsed, onProgress);
        } catch (error) {
          parseFailure = error as RuntimeProviderError;
          this.terminate(active);
          return;
        }
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
        throw classifyClaudeFailure(error, { phase: "spawn" });
      }
      if (stdout.trim() && !parseFailure) {
        parseClaudeStreamLine(stdout.trim(), parsed, onProgress);
      }
      if (active.cancelled) throw new RunCancelledError();
      if (active.timedOut) {
        throw new RuntimeProviderError(
          "RUNTIME_TIMEOUT",
          "Claude Code runtime timed out",
          { phase: "timeout" },
        );
      }
      if (active.outputExceeded) {
        throw new RuntimeProviderError(
          "RUNTIME_OUTPUT_LIMIT",
          "Claude Code output exceeded the configured limit",
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
      if (
        (exitCode !== 0 || parsed.errors.length > 0) &&
        !completedStructuredOutputBeforeMaxTurns(parsed)
      ) {
        throw classifyClaudeFailure(parsed.errors.at(-1) ?? stderr, {
          phase: "provider_exit",
          exitCode,
        });
      }
      let final: unknown;
      try {
        final = extractClaudeFinalResult(parsed);
      } catch (error) {
        if (!(error instanceof RuntimeProviderError)) throw error;
        throw new RuntimeProviderError(error.code, error.message, {
          phase: "structured_output",
          exitCode,
        });
      }
      return {
        provider: "claude",
        ...(request.sessionMode !== "ephemeral" && parsed.sessionId
          ? { sessionId: parsed.sessionId }
          : {}),
        final,
        changedFiles: [],
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

  private terminate(active: ActiveClaudeProcess): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
    for (const name of [
      "PATH",
      "PATHEXT",
      "SystemRoot",
      "WINDIR",
      "ComSpec",
      "HOME",
      "USERPROFILE",
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
    ] as const) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    if (this.config.claudeApiKey) {
      environment.ANTHROPIC_API_KEY = this.config.claudeApiKey;
    }
    if (this.config.claudeBaseUrl) {
      environment.ANTHROPIC_BASE_URL = this.config.claudeBaseUrl;
    }
    if (this.config.claudeModel) {
      environment.ANTHROPIC_MODEL = this.config.claudeModel;
    }
    return environment;
  }
}
