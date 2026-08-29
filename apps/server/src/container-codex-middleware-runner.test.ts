import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { buildContainerMiddlewareRunArgs } from "./container-codex-middleware-runner.js";
import type { MiddlewareRunRequest } from "./runtime-contract.js";

describe("Container Codex middleware invocation", () => {
  it("mounts a read-only workspace while retaining ModelArk transport", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "C:\\runtime\\codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const request: MiddlewareRunRequest = {
      agentId: "bob",
      provider: "codex",
      purpose: "create_context_pack",
      workspacePath: "C:\\approved\\workspace",
      runtimePrompt: "Summarize approved sources",
      persistedSummary: "Create approved ContextPack",
      sessionMode: "ephemeral",
      sandboxMode: "read-only",
      networkMode: "none",
      outputSchemaName: "context-pack.schema.json",
      correlationId: "corr-1",
      maxTurns: 2,
    };
    const args = buildContainerMiddlewareRunArgs(
      request,
      config,
      "C:\\temp\\schema.json",
    );

    expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual([
      "--network",
      "bridge",
    ]);
    expect(args).toContain(
      "type=bind,src=C:\\approved\\workspace,dst=/workspace,readonly",
    );
    expect(args).toContain(
      "type=bind,src=C:\\temp\\schema.json,dst=/tmp/telagent-output-schema.json,readonly",
    );
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--interactive");
    expect(args).toContain("read-only");
    expect(args).toContain('approval_policy="never"');
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
    expect(args).not.toContain("Summarize approved sources");
    expect(args).not.toContain("danger-full-access");
  });
});
