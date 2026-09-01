/**
 * EVALUATION RUNNERS.
 *
 * Four implementations behind one interface:
 *
 *   FakeProtocolRunner   deterministic, offline, free. What CI uses.
 *   ClaudeCliRunner      `claude -p`, live.
 *   CodexCliRunner       `codex exec`, live.
 *   DeepSeekCodexRunner  `codex exec` backed by DeepSeek V4 Flash, live.
 *
 * hien.md §12 is unambiguous that normal CI must not require hundreds of paid
 * live CLI calls, and §19 that live evaluation must not become mandatory. The
 * enforcement is structural rather than documentary: `npm test` imports only
 * the fake, and the live runners refuse to construct unless `TELAEGENT_LIVE_EVAL`
 * is set. Forgetting the flag produces a clear error rather than a bill.
 *
 * Runner selection deliberately does not fall back. If Codex is requested and
 * unavailable, the run fails; it does not quietly produce Claude numbers and
 * label them Codex. hien.md §19 warns against assuming the two behave alike,
 * and a silent substitution would make the comparison actively misleading.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { providerCompatibleSchema } from "../../../provider-output-schema.js";
import type { AgentProvider } from "../../../runtime-contract.js";
import type { RenderedPrompt } from "../contract.js";

const execFileAsync = promisify(execFile);

/* ========================================================================== *
 * Interface
 * ========================================================================== */

export interface RunnerRequest {
  prompt: RenderedPrompt;
  /** Absolute path to the materialised fixture repository. */
  workspacePath: string;
  /** JSON Schema the provider should constrain output to, when supported. */
  outputSchema: Record<string, unknown>;
  /** Hard ceiling per turn. */
  timeoutMs: number;
}

export interface RunnerResult {
  /** Raw stdout. Parsed by schemas.ts, never here. */
  raw: string;
  durationMs: number;
  exitCode: number;
  /** Provider session id, when one was created and reported. */
  sessionRef?: string | undefined;
  /** Populated when the process failed rather than produced a bad answer. */
  error?: string | undefined;
}

export interface ProtocolRunner {
  readonly id: string;
  readonly provider: AgentProvider | "fake";
  run(request: RunnerRequest): Promise<RunnerResult>;
}

/* ========================================================================== *
 * Live gate
 * ========================================================================== */

export const LIVE_EVAL_ENV_VAR = "TELAEGENT_LIVE_EVAL";

export function liveEvalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LIVE_EVAL_ENV_VAR] === "1" || env[LIVE_EVAL_ENV_VAR] === "true";
}

function requireLiveEval(runnerName: string, env: NodeJS.ProcessEnv): void {
  if (liveEvalEnabled(env)) return;
  throw new Error(
    runnerName +
      " makes real, billable provider calls and is disabled by default. " +
      "Set " +
      LIVE_EVAL_ENV_VAR +
      "=1 to enable it, and do not set it in CI.",
  );
}

/* ========================================================================== *
 * Process helper
 * ========================================================================== */

/**
 * execFile with stdin closed immediately.
 *
 * Both CLIs wait about three seconds for piped input that is never coming, then
 * print a warning and continue. On a 330-turn sweep that is seventeen wasted
 * minutes, and the warning lands on stdout ahead of the JSON, which the
 * extractor then has to step over. `promisify(execFile)` gives no way to set
 * `stdio`, but it returns a PromiseWithChild — so the child's stdin can simply
 * be ended the moment it exists.
 */
function execFileNoStdin(
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  const pending = execFileAsync(file, args, options);
  pending.child.stdin?.end();
  return pending;
}

/* ========================================================================== *
 * Fake runner
 * ========================================================================== */

export type FakeResponder = (request: RunnerRequest) => string;

/**
 * The CI runner.
 *
 * Keyed by a caller-supplied responder so a test can express "given this
 * prompt, the model says this", which is what makes the guard, parser and
 * scoring paths testable without a network. It is not a model simulator and
 * must not become one: its job is to let the *machinery around* the model be
 * tested deterministically, and a fake that tried to be clever would start
 * passing tests the real thing would fail.
 */
export class FakeProtocolRunner implements ProtocolRunner {
  readonly id = "fake";
  readonly provider = "fake" as const;

  private readonly calls: RunnerRequest[] = [];

  constructor(private readonly responder: FakeResponder) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls.push(request);
    const raw = this.responder(request);
    return {
      raw,
      durationMs: 0,
      exitCode: 0,
      sessionRef: "fake-session",
    };
  }

  /** Every request seen, for assertions about what was actually sent. */
  callLog(): readonly RunnerRequest[] {
    return this.calls;
  }

  lastPrompt(): RenderedPrompt | undefined {
    return this.calls[this.calls.length - 1]?.prompt;
  }
}

/* ========================================================================== *
 * Claude Code CLI
 * ========================================================================== */

/**
 * `claude -p`, non-interactive.
 *
 * The system prompt goes through `--append-system-prompt` rather than being
 * concatenated into the user text. That keeps the measurement honest: the
 * instruction block is stable across every case, so putting it where the
 * provider treats it as an instruction is both what production would do and
 * what makes prompt caching possible. Concatenating would change what is being
 * measured.
 *
 * Tool access is left at the CLI's default so the agent can actually read the
 * repository — the recipient cases are meaningless if it cannot. The isolation
 * that matters is the workspace directory, which is enforced by `cwd`, and by
 * the fixture being a throwaway temp tree.
 */
export class ClaudeCliRunner implements ProtocolRunner {
  readonly id = "claude";
  readonly provider = "claude" as const;

  constructor(
    private readonly binary: string = "claude",
    env: NodeJS.ProcessEnv = process.env,
  ) {
    requireLiveEval("ClaudeCliRunner", env);
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const started = Date.now();
    const args = [
      "-p",
      request.prompt.user,
      "--append-system-prompt",
      request.prompt.system,
      "--output-format",
      "text",
    ];

    try {
      const { stdout } = await execFileNoStdin(this.binary, args, {
        cwd: request.workspacePath,
        timeout: request.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        // A fresh, minimal environment. Inheriting the developer's shell would
        // let a stray API key or provider override change results between
        // machines, which is exactly the kind of irreproducibility that makes
        // an evaluation worthless.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
        },
      });
      return { raw: stdout, durationMs: Date.now() - started, exitCode: 0 };
    } catch (error) {
      return toFailure(error, started);
    }
  }
}

/* ========================================================================== *
 * Codex CLI
 * ========================================================================== */

/**
 * `codex exec`, non-interactive.
 *
 * `--sandbox read-only` is set explicitly. The evaluation never needs a write,
 * and a read-only sandbox means a prompt-injection case that succeeds in
 * persuading the agent to modify the repository fails at the OS boundary rather
 * than corrupting the fixture for every subsequent case in the run.
 *
 * System and user text are concatenated because the CLI takes a single prompt
 * argument. That is a genuine asymmetry with the Claude runner and it belongs
 * in the report rather than being hidden: it is one of the reasons the two
 * providers' numbers are not directly comparable, only their rankings across
 * formats are.
 */
export class CodexCliRunner implements ProtocolRunner {
  readonly id = "codex";
  readonly provider = "codex" as const;

  constructor(
    private readonly binary: string = "codex",
    env: NodeJS.ProcessEnv = process.env,
  ) {
    requireLiveEval("CodexCliRunner", env);
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const started = Date.now();
    const runRoot = await mkdtemp(path.join(tmpdir(), "telaegent-codex-run-"));
    const schemaPath = path.join(runRoot, "output-schema.json");
    const outputPath = path.join(runRoot, "last-message.json");
    const combined = request.prompt.system + "\n\n---\n\n" + request.prompt.user;

    await writeFile(
      schemaPath,
      JSON.stringify(codexCompatibleSchema(request.outputSchema)),
      "utf8",
    );
    const args = codexStructuredArgs(schemaPath, outputPath, combined);

    try {
      await execFileNoStdin(this.binary, args, {
        cwd: request.workspacePath,
        timeout: request.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
        },
      });
      const raw = await readFile(outputPath, "utf8");
      return { raw, durationMs: Date.now() - started, exitCode: 0 };
    } catch (error) {
      return toFailure(error, started);
    } finally {
      await rm(runRoot, { recursive: true, force: true });
    }
  }
}

/** Pure argument builder so CI proves native schema enforcement stays wired. */
export function codexStructuredArgs(
  schemaPath: string,
  outputPath: string,
  prompt: string,
): string[] {
  return [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--config",
    "model_reasoning_effort=low",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    prompt,
  ];
}

/**
 * OpenAI Structured Outputs accepts `anyOf` but rejects JSON Schema `oneOf`.
 * Zod emits `oneOf` for the two resource-request variants, so translate that
 * keyword without changing either alternative. The normal Zod parser remains
 * the final local authority after the provider response returns.
 */
export function codexCompatibleSchema(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return providerCompatibleSchema("codex", value);
}

/* ========================================================================== *
 * DeepSeek V4 Flash through Codex CLI
 * ========================================================================== */

/**
 * Runs the same repository-aware Codex harness against DeepSeek V4 Flash.
 *
 * Using Codex as the agent shell preserves the important part of the live
 * corpus: the model can inspect the materialised repository through a
 * read-only tool boundary. Calling the OpenAI-compatible HTTP endpoint
 * directly would turn every grounding case into a closed-book question.
 *
 * Provider configuration is supplied only for this child process. The API key
 * is read from `AI_KEY`; it is never written to config, command arguments,
 * reports, or the repository. `--ignore-user-config` also keeps the user's
 * normal Codex/ChatGPT setup out of the measurement.
 */
export class DeepSeekCodexRunner implements ProtocolRunner {
  readonly id = "deepseek-v4-flash";
  readonly provider = "codex" as const;

  constructor(
    private readonly binary: string = "codex",
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    requireLiveEval("DeepSeekCodexRunner", env);
    if (env.AI_KEY?.trim() === "") {
      throw new Error("DeepSeekCodexRunner requires AI_KEY in the process environment.");
    }
    if (env.AI_KEY === undefined) {
      throw new Error("DeepSeekCodexRunner requires AI_KEY in the process environment.");
    }
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const started = Date.now();
    const runRoot = await mkdtemp(path.join(tmpdir(), "telaegent-deepseek-run-"));
    const schemaPath = path.join(runRoot, "output-schema.json");
    const outputPath = path.join(runRoot, "last-message.json");
    const combined = request.prompt.system + "\n\n---\n\n" + request.prompt.user;

    await writeFile(schemaPath, JSON.stringify(request.outputSchema), "utf8");

    const args = [
      "exec",
      "--ignore-user-config",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--model",
      "deepseek-v4-flash",
      "--config",
      "model_provider=deepseek",
      "--config",
      "model_reasoning_effort=low",
      "--config",
      "model_providers.deepseek.name=deepseek",
      "--config",
      "model_providers.deepseek.base_url=https://api.deepseek.com/",
      "--config",
      "model_providers.deepseek.wire_api=responses",
      "--config",
      "model_providers.deepseek.env_key=AI_KEY",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      combined,
    ];

    try {
      await execFileNoStdin(this.binary, args, {
        cwd: request.workspacePath,
        timeout: request.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          PATH: this.env.PATH ?? "",
          AI_KEY: this.env.AI_KEY ?? "",
        },
      });
      const raw = await readFile(outputPath, "utf8");
      return { raw, durationMs: Date.now() - started, exitCode: 0 };
    } catch (error) {
      return toFailure(error, started);
    } finally {
      // `runRoot` is the exact directory returned by mkdtemp above. Nothing
      // caller-controlled is ever used as a recursive deletion target.
      await rm(runRoot, { recursive: true, force: true });
    }
  }
}

/* ========================================================================== *
 * Failure handling
 * ========================================================================== */

/**
 * A failed process is a result, not an exception.
 *
 * A timeout or a non-zero exit is data the report needs — "format P4 timed out
 * on 6 of 66 cases" is a finding about P4. Throwing would abort the run and
 * lose the other 60 results, which on a live evaluation means paying for them
 * twice.
 *
 * stdout is preserved on failure because a CLI that hits its turn limit often
 * emits a usable answer before exiting non-zero.
 */
function toFailure(error: unknown, started: number): RunnerResult {
  const shaped = error as {
    stdout?: string;
    stderr?: string;
    code?: number;
    killed?: boolean;
    message?: string;
  };
  const failureText = shaped.stderr?.trim()
    ? shaped.stderr
    : (shaped.message ?? "");
  return {
    raw: shaped.stdout ?? "",
    durationMs: Date.now() - started,
    exitCode: typeof shaped.code === "number" ? shaped.code : 1,
    error:
      shaped.killed === true
        ? "timed out"
        : failureText || "unknown runner failure",
  };
}

/* ========================================================================== *
 * Selection
 * ========================================================================== */

export type RunnerId = "fake" | "claude" | "codex" | "deepseek";

/**
 * Builds a runner by id. Never falls back to a different provider.
 */
export function createRunner(
  id: RunnerId,
  options: { responder?: FakeResponder; env?: NodeJS.ProcessEnv } = {},
): ProtocolRunner {
  const env = options.env ?? process.env;
  switch (id) {
    case "fake":
      return new FakeProtocolRunner(
        options.responder ??
          (() =>
            JSON.stringify({
              state: "blocked",
              assistantMessage: "no responder configured",
              sendCandidate: null,
              riskFlags: ["ambiguous_request"],
              referencedPaths: [],
            })),
      );
    case "claude":
      return new ClaudeCliRunner("claude", env);
    case "codex":
      return new CodexCliRunner("codex", env);
    case "deepseek":
      return new DeepSeekCodexRunner("codex", env);
  }
}
