import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import type {
  JsonSchemaDocument,
  MiddlewareProviderRunner,
  MiddlewareRunRequest,
} from "./runtime-contract.js";
import { RuntimeProviderRegistry } from "./runtime-provider-registry.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

class UnusedPlaygroundRunner implements AgentRunner {
  async run(_request: RunnerRequest): Promise<RunnerResult> {
    throw new Error("Playground runner must not be called by a provider probe");
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

async function makeService(runner: MiddlewareProviderRunner) {
  const root = await mkdtemp(path.join(tmpdir(), "telaegent-connection-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
  });
  const registry = new RuntimeProviderRegistry([runner], {
    resolve: async () => ({ type: "object" }),
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    new UnusedPlaygroundRunner(),
    registry,
  );
  await service.initialize();
  return service;
}

describe("AgentService provider connections", () => {
  it("uses the backend-owned Agent workspace for an ephemeral live probe", async () => {
    let receivedRequest: MiddlewareRunRequest | null = null;
    let receivedSchema: JsonSchemaDocument | null = null;
    const runner: MiddlewareProviderRunner = {
      provider: "codex",
      capability: async () => ({
        installed: true,
        authenticated: true,
        reason: null,
      }),
      runStructured: async (request, schema) => {
        receivedRequest = request;
        receivedSchema = schema;
        return {
          provider: "codex",
          final: { connected: true },
          changedFiles: [],
          exitCode: 0,
          durationMs: 17,
        };
      },
      cancel: async () => false,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Provider owner" });

    const before = await service.providerConnectionStatuses(agent.id);
    expect(before).toContainEqual(
      expect.objectContaining({ provider: "codex", state: "not_connected" }),
    );

    await expect(
      service.probeProviderConnection(agent.id, "codex", "request-1"),
    ).resolves.toMatchObject({
      bindingId: agent.id,
      provider: "codex",
      state: "connected",
      lastProbeLatencyMs: 17,
    });
    expect(receivedRequest).toMatchObject({
      agentId: agent.id,
      provider: "codex",
      workspacePath: agent.workspacePath,
      sessionMode: "ephemeral",
      sandboxMode: "read-only",
      networkMode: "none",
      correlationId: "request-1",
      maxTurns: 1,
    });
    expect(receivedSchema).toMatchObject({
      properties: { connected: { const: true } },
    });
  });

  it("reports an invalid live response as unavailable without persisting detail", async () => {
    const runner: MiddlewareProviderRunner = {
      provider: "claude",
      capability: async () => ({
        installed: true,
        authenticated: true,
        reason: null,
      }),
      runStructured: async () => ({
        provider: "claude",
        final: { connected: false, detail: "private provider output" },
        changedFiles: [],
        exitCode: 0,
        durationMs: 10,
      }),
      cancel: async () => false,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Claude owner" });

    const status = await service.probeProviderConnection(agent.id, "claude");
    expect(status).toMatchObject({
      state: "unavailable",
      reason: "INVALID_AGENT_OUTPUT",
    });
    expect(JSON.stringify(status)).not.toContain("private provider output");
  });
});
