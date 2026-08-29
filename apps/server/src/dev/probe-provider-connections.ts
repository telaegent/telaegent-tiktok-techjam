import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { ClaudeCodeRunner } from "../claude-code-runner.js";
import { CodexRunner } from "../codex-runner.js";
import { loadConfig } from "../config.js";
import { ProviderConnectionService } from "../provider-connection-service.js";
import { RuntimeProviderRegistry } from "../runtime-provider-registry.js";
import type { AgentProvider } from "../runtime-contract.js";

const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const config = loadConfig({
  ...process.env,
  NODE_ENV: "development",
  CODEX_HOME: codexHome,
});
const registry = new RuntimeProviderRegistry(
  [new CodexRunner(config), new ClaudeCodeRunner(config)],
  {
    resolve: async () => {
      throw new Error("Connection probes use their internal schema");
    },
  },
);
const connections = new ProviderConnectionService(registry);
const workspaces = new Map<AgentProvider, string>();

try {
  for (const provider of ["claude", "codex"] as const) {
    const workspacePath = await mkdtemp(
      path.join(tmpdir(), `telaegent-${provider}-probe-`),
    );
    workspaces.set(provider, workspacePath);
    const bindingId = `local:${provider}`;
    const before = await connections.inspect(bindingId, provider);
    console.log(`${provider}: ${before.state} (auth=${before.authenticated})`);
    const after = await connections.probe({
      bindingId,
      agentId: `probe-${provider}`,
      provider,
      workspacePath,
      correlationId: randomUUID(),
    });
    console.log(
      `${provider}: ${after.state}` +
        (after.lastProbeLatencyMs === undefined
          ? ` (${after.reason ?? "unknown"})`
          : ` (${after.lastProbeLatencyMs}ms)`),
    );
  }
} finally {
  await Promise.all(
    [...workspaces.values()].map((workspacePath) =>
      rm(workspacePath, { recursive: true, force: true }),
    ),
  );
}
