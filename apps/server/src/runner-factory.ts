import { ClaudeCodeRunner } from "./claude-code-runner.js";
import type { AppConfig } from "./config.js";
import { ContainerCodexMiddlewareRunner } from "./container-codex-middleware-runner.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import {
  FileOutputSchemaResolver,
  RuntimeProviderRegistry,
} from "./runtime-provider-registry.js";
import type { AgentRunner } from "./types.js";

export function createRunner(config: AppConfig): AgentRunner {
  return config.runtimeProvider === "container"
    ? new ContainerCodexRunner(config)
    : new CodexRunner(config);
}

export function createRuntimeProviderRegistry(
  config: AppConfig,
): RuntimeProviderRegistry {
  const codex =
    config.runtimeProvider === "container"
      ? new ContainerCodexMiddlewareRunner(config)
      : new CodexRunner(config);
  return new RuntimeProviderRegistry(
    [codex, new ClaudeCodeRunner(config)],
    new FileOutputSchemaResolver(config.runtimeOutputSchemaRoot),
  );
}
