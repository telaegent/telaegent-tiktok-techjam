import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});
import { ClaudeCodeRunner } from "./claude-code-runner.js";
import { loadConfig } from "./config.js";

describe("Claude local capability detection", () => {
  beforeEach(() => execute.mockReset());
  const runner = () => new ClaudeCodeRunner(loadConfig({ NODE_ENV: "test" }));

  it("distinguishes an absent executable from a failed version check", async () => {
    execute.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    expect(await runner().capability()).toEqual({ installed: false, authenticated: false, reason: "not_installed" });
    execute.mockRejectedValueOnce(Object.assign(new Error("timeout"), { killed: true }));
    expect(await runner().capability()).toEqual({ installed: true, authenticated: false, reason: "probe_failed" });
  });

  it("does not misdiagnose malformed auth output as a signed-out account", async () => {
    execute.mockResolvedValueOnce({ stdout: "version" }).mockResolvedValueOnce({ stdout: "invalid-json" });
    expect(await runner().capability()).toEqual({ installed: true, authenticated: false, reason: "probe_failed" });
  });

  it.each([true, false])("recognizes loggedIn=%s without running a model", async (loggedIn) => {
    execute.mockResolvedValueOnce({ stdout: "version" }).mockResolvedValueOnce({ stdout: JSON.stringify({ loggedIn }) });
    expect(await runner().capability()).toEqual({ installed: true, authenticated: loggedIn, reason: loggedIn ? null : "not_authenticated" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith("claude", ["auth", "status", "--json"], expect.objectContaining({ timeout: 5_000 }));
  });
});
