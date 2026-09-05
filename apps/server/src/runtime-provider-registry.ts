import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  RuntimeProviderError,
  safeRuntimeError,
} from "./runtime-errors.js";
import type {
  AgentProvider,
  JsonSchemaDocument,
  MiddlewareProviderRunner,
  MiddlewareRunRequest,
  NormalizedRunResult,
  RuntimeCapabilities,
  RuntimeOutputSchemaResolver,
  RuntimeProviderCapability,
  RuntimeProviderProbeRequest,
  RuntimeProviderProbeResult,
  RuntimeProgressSink,
} from "./runtime-contract.js";
import { throwIfRuntimeCancelled } from "./runtime-cancellation.js";

const schemaNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.schema\.json$/;
const maximumSchemaBytes = 512 * 1024;
const providerProbeSchema: JsonSchemaDocument = {
  type: "object",
  properties: { connected: { type: "boolean", const: true } },
  required: ["connected"],
  additionalProperties: false,
};

export class FileOutputSchemaResolver implements RuntimeOutputSchemaResolver {
  constructor(private readonly schemaRoot: string) {}

  async resolve(outputSchemaName: string): Promise<JsonSchemaDocument> {
    if (!schemaNamePattern.test(outputSchemaName)) {
      throw new RuntimeProviderError(
        "INVALID_AGENT_OUTPUT",
        "Unknown runtime output schema",
      );
    }
    const root = path.resolve(this.schemaRoot);
    const schemaPath = path.resolve(root, outputSchemaName);
    if (path.dirname(schemaPath) !== root) {
      throw new RuntimeProviderError(
        "INVALID_AGENT_OUTPUT",
        "Unknown runtime output schema",
      );
    }
    let contents: string;
    try {
      contents = await readFile(schemaPath, "utf8");
    } catch {
      throw new RuntimeProviderError(
        "RUNTIME_UNAVAILABLE",
        "Runtime output schema is unavailable",
      );
    }
    if (Buffer.byteLength(contents, "utf8") > maximumSchemaBytes) {
      throw new RuntimeProviderError(
        "INVALID_AGENT_OUTPUT",
        "Runtime output schema is too large",
      );
    }
    try {
      const parsed = JSON.parse(contents) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Schema must be an object");
      }
      return parsed as JsonSchemaDocument;
    } catch {
      throw new RuntimeProviderError(
        "INVALID_AGENT_OUTPUT",
        "Runtime output schema is invalid",
      );
    }
  }
}

/** Local connector-side registry. It requires a locally resolved workspace. */
export class RuntimeProviderRegistry {
  private readonly runners = new Map<AgentProvider, MiddlewareProviderRunner>();

  constructor(
    runners: MiddlewareProviderRunner[],
    private readonly schemas: RuntimeOutputSchemaResolver,
  ) {
    for (const runner of runners) {
      if (this.runners.has(runner.provider)) {
        throw new Error("Duplicate runtime provider: " + runner.provider);
      }
      this.runners.set(runner.provider, runner);
    }
  }

  async run(
    request: MiddlewareRunRequest,
    onProgress?: RuntimeProgressSink,
    signal?: AbortSignal,
  ): Promise<NormalizedRunResult> {
    const runner = this.runners.get(request.provider);
    if (!runner) {
      throw new RuntimeProviderError(
        "RUNTIME_UNAVAILABLE",
        request.provider === "codex"
          ? "Codex runtime is unavailable"
          : "Claude Code runtime is unavailable",
      );
    }
    try {
      throwIfRuntimeCancelled(signal);
      if (!request.workspacePath) {
        throw new RuntimeProviderError(
          "UNSUPPORTED_RUNTIME_POLICY",
          "Local connector has not resolved a registered workspace",
        );
      }
      const schema = await this.schemas.resolve(request.outputSchemaName);
      throwIfRuntimeCancelled(signal);
      return await runner.runStructured(
        { ...request, workspacePath: request.workspacePath },
        schema,
        onProgress,
        signal,
      );
    } catch (error) {
      throw safeRuntimeError(error);
    }
  }

  async capability(provider: AgentProvider): Promise<RuntimeProviderCapability> {
    const runner = this.runners.get(provider);
    if (!runner) {
      return {
        installed: false,
        authenticated: false,
        reason: "not_installed",
      };
    }
    try {
      return await runner.capability();
    } catch {
      return {
        installed: false,
        authenticated: false,
        reason: "probe_failed",
      };
    }
  }

  async probe(
    request: RuntimeProviderProbeRequest,
    onProgress?: RuntimeProgressSink,
  ): Promise<RuntimeProviderProbeResult> {
    const runner = this.runners.get(request.provider);
    if (!runner) {
      throw new RuntimeProviderError(
        "RUNTIME_UNAVAILABLE",
        request.provider === "codex"
          ? "Codex runtime is unavailable"
          : "Claude Code runtime is unavailable",
      );
    }
    try {
      const result = await runner.runStructured(
        {
          agentId: request.agentId,
          provider: request.provider,
          purpose: "sender_draft",
          workspacePath: request.workspacePath,
          runtimePrompt: [
            "This is a Telaegent provider connection probe.",
            "Do not inspect files or call tools.",
            "Return the required object with connected set to true.",
          ].join("\n"),
          persistedSummary: "Provider connection probe",
          sessionMode: "ephemeral",
          sandboxMode: "read-only",
          networkMode: "none",
          outputSchemaName: "provider-connection-probe.schema.json",
          correlationId: request.correlationId,
          maxTurns: 1,
        },
        providerProbeSchema,
        onProgress,
      );
      if (
        !result.final ||
        typeof result.final !== "object" ||
        Array.isArray(result.final) ||
        (result.final as Record<string, unknown>).connected !== true
      ) {
        throw new RuntimeProviderError(
          "INVALID_AGENT_OUTPUT",
          "Provider connection probe returned an invalid result",
        );
      }
      return { provider: request.provider, durationMs: result.durationMs };
    } catch (error) {
      throw safeRuntimeError(error);
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const results = await Promise.all(
      [...this.runners.values()].map((runner) => runner.cancel(agentId)),
    );
    return results.some(Boolean);
  }

  /**
   * Stops every run every registered runner owns. Call on shutdown.
   *
   * Local provider children are spawned into their own process group so a
   * cancel reaches the whole tree; that same detachment means a terminal
   * Ctrl-C no longer reaches them, so they must be stopped explicitly or they
   * keep running against the owner's repository after the process quits.
   */
  async cancelAll(): Promise<void> {
    await Promise.all(
      [...this.runners.values()].map((runner) =>
        runner.cancelAll?.().catch(() => undefined) ?? Promise.resolve(),
      ),
    );
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    const entries = await Promise.all(
      (["codex", "claude"] as const).map(async (provider) => {
        return [provider, await this.capability(provider)] as const;
      }),
    );
    return Object.fromEntries(entries) as RuntimeCapabilities;
  }
}
