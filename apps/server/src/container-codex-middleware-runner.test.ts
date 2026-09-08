import { describe, expect, it } from "vitest";
import { NO_TOOLS_PERMISSION_PROFILE } from "./codex-runner.js";
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

  it("mounts the directory the caller names, not the one on the request", () => {
    // A turn that declared no tools is pointed at an empty directory instead
    // of the repository. Inside the container a shell still reaches the image
    // and /codex-home, so the mount is not the enforcement -- the permission
    // profile is. It removes the thing worth reaching for and keeps the
    // repository path out of argv the model could read back.
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "k",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "C:\\runtime\\codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const request: MiddlewareRunRequest = {
      agentId: "bob",
      provider: "codex",
      purpose: "sender_draft",
      workspacePath: "C:\\approved\\workspace",
      runtimePrompt: "Draft from the note",
      persistedSummary: "Approved context",
      sessionMode: "ephemeral",
      sandboxMode: "read-only",
      networkMode: "none",
      outputSchemaName: "sender-turn.schema.json",
      correlationId: "corr-no-tools",
      maxTurns: 1,
      toolMode: "none",
    };
    const args = buildContainerMiddlewareRunArgs(
      request,
      config,
      "C:\\temp\\schema.json",
      "C:\\temp\\telagent-notools-abc",
    );

    expect(args).toContain(
      "type=bind,src=C:\\temp\\telagent-notools-abc,dst=/workspace,readonly",
    );
    expect(args.join(" ")).not.toContain("C:\\approved\\workspace");
    // The container runner shares the local runner's argv builder, so the
    // deny reaches the codex inside the container too. Asserted here because
    // the two runners are free to drift and only one of them is where a
    // toolless turn actually ships.
    expect(args).toContain(
      `default_permissions="${NO_TOOLS_PERMISSION_PROFILE}"`,
    );
    expect(args).toContain(
      `permissions.${NO_TOOLS_PERMISSION_PROFILE}.filesystem={":root"="deny"}`,
    );
    // The mount stays read-only, but `--sandbox` must not reach codex: it
    // would replace the deny with a built-in that reads the whole container.
    expect(args).not.toContain("--sandbox");
  });
});
