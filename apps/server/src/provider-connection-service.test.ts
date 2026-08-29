import { describe, expect, it } from "vitest";
import {
  ProviderConnectionService,
  type ProviderConnectionRuntime,
} from "./provider-connection-service.js";
import type {
  RuntimeProviderCapability,
  RuntimeProviderProbeRequest,
  RuntimeProviderProbeResult,
} from "./runtime-contract.js";
import { RuntimeProviderError } from "./runtime-errors.js";

const connectedCapability: RuntimeProviderCapability = {
  installed: true,
  authenticated: true,
  reason: null,
};

function target(bindingId = "user-a:repo-x") {
  return {
    bindingId,
    agentId: "agent-a",
    provider: "codex" as const,
    workspacePath: "/runtime/user-a/repo-x",
    correlationId: "corr-1",
  };
}

describe("ProviderConnectionService", () => {
  it("requires a successful live probe before reporting connected", async () => {
    const runtime: ProviderConnectionRuntime = {
      capability: async () => connectedCapability,
      probe: async () => ({ provider: "codex", durationMs: 42 }),
    };
    const service = new ProviderConnectionService(
      runtime,
      () => new Date("2026-08-29T12:00:00.000Z"),
    );

    await expect(service.inspect("user-a:repo-x", "codex")).resolves.toMatchObject({
      state: "not_connected",
      installed: true,
      authenticated: true,
    });
    await expect(service.probe(target())).resolves.toEqual({
      bindingId: "user-a:repo-x",
      provider: "codex",
      state: "connected",
      installed: true,
      authenticated: true,
      reason: null,
      checkedAt: "2026-08-29T12:00:00.000Z",
      lastProbeAt: "2026-08-29T12:00:00.000Z",
      lastProbeLatencyMs: 42,
    });
  });

  it("exposes connecting while one deduplicated probe is active", async () => {
    let resolveProbe!: (result: RuntimeProviderProbeResult) => void;
    const pending = new Promise<RuntimeProviderProbeResult>((resolve) => {
      resolveProbe = resolve;
    });
    let probeCalls = 0;
    const runtime: ProviderConnectionRuntime = {
      capability: async () => connectedCapability,
      probe: async () => {
        probeCalls += 1;
        return pending;
      },
    };
    const service = new ProviderConnectionService(runtime);

    const first = service.probe(target());
    const second = service.probe(target());
    expect(service.peek("user-a:repo-x", "codex")?.state).toBe("connecting");
    resolveProbe({ provider: "codex", durationMs: 25 });

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { state: "connected" },
      { state: "connected" },
    ]);
    expect(probeCalls).toBe(1);
  });

  it("reports reconnect_required when authentication is missing or expires", async () => {
    let capability = connectedCapability;
    const runtime: ProviderConnectionRuntime = {
      capability: async () => capability,
      probe: async () => ({ provider: "codex", durationMs: 10 }),
    };
    const service = new ProviderConnectionService(runtime);

    await service.probe(target());
    capability = {
      installed: true,
      authenticated: false,
      reason: "not_authenticated",
    };

    await expect(service.inspect("user-a:repo-x", "codex")).resolves.toMatchObject({
      state: "reconnect_required",
      authenticated: false,
      reason: "not_authenticated",
    });
  });

  it("normalizes live authentication failures without exposing provider detail", async () => {
    const runtime: ProviderConnectionRuntime = {
      capability: async () => connectedCapability,
      probe: async () => {
        throw new RuntimeProviderError(
          "RUNTIME_AUTHENTICATION_FAILED",
          "secret provider detail",
        );
      },
    };
    const service = new ProviderConnectionService(runtime);

    const status = await service.probe(target());
    expect(status).toMatchObject({
      state: "reconnect_required",
      authenticated: false,
      reason: "RUNTIME_AUTHENTICATION_FAILED",
    });
    expect(JSON.stringify(status)).not.toContain("secret provider detail");
  });

  it("keeps connection state isolated by runtime binding and provider", async () => {
    const requests: RuntimeProviderProbeRequest[] = [];
    const runtime: ProviderConnectionRuntime = {
      capability: async () => connectedCapability,
      probe: async (request) => {
        requests.push(request);
        return { provider: request.provider, durationMs: 10 };
      },
    };
    const service = new ProviderConnectionService(runtime);

    await service.probe(target("user-a:repo-x"));

    expect(service.peek("user-a:repo-x", "codex")?.state).toBe("connected");
    expect(service.peek("user-b:repo-x", "codex")).toBeNull();
    expect(service.peek("user-a:repo-x", "claude")).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("reports an unavailable CLI without spending a live probe", async () => {
    let probeCalls = 0;
    const runtime: ProviderConnectionRuntime = {
      capability: async () => ({
        installed: false,
        authenticated: false,
        reason: "not_installed",
      }),
      probe: async () => {
        probeCalls += 1;
        throw new Error("must not run");
      },
    };
    const service = new ProviderConnectionService(runtime);

    await expect(service.probe(target())).resolves.toMatchObject({
      state: "unavailable",
      installed: false,
      reason: "not_installed",
    });
    expect(probeCalls).toBe(0);
  });
});
