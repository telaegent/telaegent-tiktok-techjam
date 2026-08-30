import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import { RuntimeProviderError } from "./runtime-errors.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("returns normalized provider failures without exposing CLI output", async () => {
    const failingService = {
      ...service,
      listAgents: () => {
        throw new RuntimeProviderError(
          "RUNTIME_AUTHENTICATION_FAILED",
          "token=secret provider stderr",
        );
      },
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), failingService);

    const response = await app.inject({ method: "GET", url: "/api/agents" });

    expect(response.statusCode).toBe(424);
    expect(response.json()).toEqual({
      error: "Agent provider authentication is required",
      code: "RUNTIME_AUTHENTICATION_FAILED",
      retryable: false,
    });
    expect(response.body).not.toContain("secret");
    await app.close();
  });

  it("does not expose unknown internal exceptions", async () => {
    const failingService = {
      ...service,
      listAgents: () => {
        throw new Error("private filesystem and credential details");
      },
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), failingService);

    const response = await app.inject({ method: "GET", url: "/api/agents" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
    await app.close();
  });

  it("exposes provider status and explicit live probes for one Agent binding", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const calls: Array<{ id: string; provider: string; correlationId: string }> = [];
    const connectionService = {
      ...service,
      providerConnectionStatuses: async (agentId: string) => [
        {
          bindingId: agentId,
          provider: "codex",
          state: "not_connected",
          installed: true,
          authenticated: true,
          reason: null,
          checkedAt: "2026-08-29T12:00:00.000Z",
        },
      ],
      probeProviderConnection: async (
        agentId: string,
        provider: string,
        correlationId: string,
      ) => {
        calls.push({ id: agentId, provider, correlationId });
        return {
          bindingId: agentId,
          provider,
          state: "connected",
          installed: true,
          authenticated: true,
          reason: null,
          checkedAt: "2026-08-29T12:00:00.000Z",
          lastProbeAt: "2026-08-29T12:00:00.000Z",
          lastProbeLatencyMs: 20,
        };
      },
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), connectionService);

    const status = await app.inject({
      method: "GET",
      url: `/api/agents/${id}/providers`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().connections[0]).toMatchObject({
      provider: "codex",
      state: "not_connected",
    });

    const probe = await app.inject({
      method: "POST",
      url: `/api/agents/${id}/providers/codex/probe`,
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json().connection).toMatchObject({
      provider: "codex",
      state: "connected",
    });
    expect(calls).toEqual([
      { id, provider: "codex", correlationId: expect.any(String) },
    ]);

    const invalid = await app.inject({
      method: "POST",
      url: `/api/agents/${id}/providers/modelark/probe`,
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });
});
