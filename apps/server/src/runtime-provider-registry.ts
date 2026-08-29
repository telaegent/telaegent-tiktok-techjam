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
} from "./runtime-contract.js";

const schemaNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.schema\.json$/;
const maximumSchemaBytes = 512 * 1024;

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

  async run(request: MiddlewareRunRequest): Promise<NormalizedRunResult> {
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
      const schema = await this.schemas.resolve(request.outputSchemaName);
      return await runner.runStructured(request, schema);
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

  async capabilities(): Promise<RuntimeCapabilities> {
    const fallback = {
      installed: false,
      authenticated: false,
      reason: "not_installed" as const,
    };
    const entries = await Promise.all(
      (["codex", "claude"] as const).map(async (provider) => {
        const runner = this.runners.get(provider);
        if (!runner) return [provider, fallback] as const;
        try {
          return [provider, await runner.capability()] as const;
        } catch {
          return [
            provider,
            {
              installed: false,
              authenticated: false,
              reason: "probe_failed" as const,
            },
          ] as const;
        }
      }),
    );
    return Object.fromEntries(entries) as RuntimeCapabilities;
  }
}
