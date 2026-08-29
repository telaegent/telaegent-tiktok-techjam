import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import {
  buildCodexMiddlewareArgs,
  parseCodexEventLine,
  type ParsedEvents,
} from "./codex-runner.js";
import { containerName } from "./container-codex-runner.js";
import { RunCancelledError } from "./errors.js";
import type {
  JsonSchemaDocument,
  MiddlewareProviderRunner,
  MiddlewareRunRequest,
  NormalizedRunResult,
  RuntimeProviderCapability,
} from "./runtime-contract.js";
import {
  RuntimeProviderError,
  classifyProviderFailure,
} from "./runtime-errors.js";

const execFileAsync = promisify(execFile);
const containerSchemaPath = "/tmp/telagent-output-schema.json";

interface ActiveContainer {
  child: ChildProcess;
  containerName: string;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  settled: Promise<void>;
  termination: Promise<void> | null;
}

export function buildContainerMiddlewareRunArgs(
  request: MiddlewareRunRequest,
  config: AppConfig,
  hostSchemaPath: string,
): string[] {
  const name = containerName(request.agentId + "-middleware", config.runtimeInstanceId);
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  const workspaceMount =
    "type=bind,src=" +
    request.workspacePath +
    ",dst=/workspace" +
    (request.sandboxMode === "read-only" ? ",readonly" : "");
  return [
    "run",
    "--rm",
    "--interactive",
    "--init",
    "--name",
    name,
    "--label",
    "io.codejam.launchpad=agent-runtime",
    "--label",
    "io.codejam.agent-id=" + request.agentId,
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    "bridge",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    "--env",
    "ARK_API_KEY",
    "--env",
    "CODEX_HOME=/codex-home",
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--mount",
    workspaceMount,
    "--mount",
    "type=bind,src=" + config.codexHome + ",dst=/codex-home",
    "--mount",
    "type=bind,src=" + hostSchemaPath + ",dst=" + containerSchemaPath + ",readonly",
    "--workdir",
    "/workspace",
    config.containerRuntimeImage,
    "codex",
    ...buildCodexMiddlewareArgs(
      request,
      containerSchemaPath,
      "/workspace",
    ),
  ];
}

export class ContainerCodexMiddlewareRunner implements MiddlewareProviderRunner {
  readonly provider = "codex" as const;
  private readonly active = new Map<string, ActiveContainer>();

  constructor(private readonly config: AppConfig) {}

  async capability(): Promise<RuntimeProviderCapability> {
    try {
      await execFileAsync(this.config.containerEngine, ["version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      await execFileAsync(
        this.config.containerEngine,
        ["image", "inspect", this.config.containerRuntimeImage],
        { timeout: 5_000, env: this.childEnvironment() },
      );
    } catch {
      return { installed: false, authenticated: false, reason: "not_installed" };
    }
    if (!isArkConfigured(this.config)) {
      return { installed: true, authenticated: false, reason: "not_configured" };
    }
    return { installed: true, authenticated: true, reason: null };
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) return false;
    active.cancelled = true;
    await this.removeContainer(active);
    await active.settled;
    return true;
  }

  async runStructured(
    request: MiddlewareRunRequest,
    outputSchema: JsonSchemaDocument,
  ): Promise<NormalizedRunResult> {
    if (!isArkConfigured(this.config)) {
      throw new RuntimeProviderError(
        "RUNTIME_UNAVAILABLE",
        "Codex runtime credentials are not configured",
      );
    }
    if (this.active.has(request.agentId)) {
      throw new RuntimeProviderError("RUNTIME_FAILED", "Agent runtime is already active");
    }
    const startedAt = Date.now();
    const schemaDirectory = await mkdtemp(path.join(tmpdir(), "telagent-schema-"));
    const hostSchemaPath = path.join(schemaDirectory, "output.schema.json");
    await writeFile(hostSchemaPath, JSON.stringify(outputSchema), {
      encoding: "utf8",
      mode: 0o600,
    });

    const child = spawn(
      this.config.containerEngine,
      buildContainerMiddlewareRunArgs(request, this.config, hostSchemaPath),
      {
        cwd: request.workspacePath,
        env: this.childEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(request.runtimePrompt);
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active: ActiveContainer = {
      child,
      containerName: containerName(
        request.agentId + "-middleware",
        this.config.runtimeInstanceId,
      ),
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      termination: null,
    };
    this.active.set(request.agentId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId:
        request.sessionMode === "continue" ? request.sessionId ?? null : null,
      usage: null,
      errors: [],
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        void this.removeContainer(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) parseCodexEventLine(line, parsed);
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
    const timeout = setTimeout(() => {
      active.timedOut = true;
      void this.removeContainer(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      let exitCode: number;
      try {
        exitCode = await new Promise<number>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => resolve(code ?? 1));
        });
      } catch (error) {
        throw classifyProviderFailure("codex", error);
      }
      if (stdout.trim()) parseCodexEventLine(stdout.trim(), parsed);
      if (active.cancelled) throw new RunCancelledError();
      if (active.timedOut) {
        throw new RuntimeProviderError("RUNTIME_TIMEOUT", "Codex runtime timed out");
      }
      if (active.outputExceeded) {
        throw new RuntimeProviderError(
          "RUNTIME_OUTPUT_LIMIT",
          "Codex output exceeded the configured limit",
        );
      }
      if (exitCode !== 0) {
        throw classifyProviderFailure(
          "codex",
          parsed.errors.at(-1) ?? stderr ?? "provider failure",
        );
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new RuntimeProviderError(
          "INVALID_AGENT_OUTPUT",
          "Codex completed without an agent message",
        );
      }
      let final: unknown;
      try {
        final = JSON.parse(output) as unknown;
      } catch {
        throw new RuntimeProviderError(
          "INVALID_AGENT_OUTPUT",
          "Codex completed without structured output",
        );
      }
      return {
        provider: "codex",
        ...(request.sessionMode === "continue" && parsed.threadId
          ? { sessionId: parsed.threadId }
          : {}),
        final,
        changedFiles: [],
        exitCode,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timeout);
      this.active.delete(request.agentId);
      await rm(schemaDirectory, { recursive: true, force: true });
    }
  }

  private removeContainer(active: ActiveContainer): Promise<void> {
    if (!active.termination) {
      active.termination = execFileAsync(
        this.config.containerEngine,
        ["rm", "--force", active.containerName],
        { timeout: 8_000, env: this.childEnvironment() },
      )
        .then(() => undefined)
        .catch(() => {
          active.child.kill("SIGTERM");
          const timer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
          timer.unref();
        });
    }
    return active.termination;
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
    };
    for (const name of [
      "PATH",
      "PATHEXT",
      "SystemRoot",
      "WINDIR",
      "ComSpec",
      "HOME",
      "TMPDIR",
      "TEMP",
      "TMP",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
    ] as const) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
