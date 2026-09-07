import { describe, expect, it, vi } from "vitest";
import type {
  RuntimeCapabilities,
  RuntimeProviderCapability,
} from "../runtime-contract.js";
import {
  connectorProviderCandidates,
  selectConnectorProviders,
} from "./connector-provider-selection.js";

const connected: RuntimeProviderCapability = {
  installed: true,
  authenticated: true,
  reason: null,
};
const missing: RuntimeProviderCapability = {
  installed: false,
  authenticated: false,
  reason: "not_installed",
};
const signedOut: RuntimeProviderCapability = {
  installed: true,
  authenticated: false,
  reason: "not_authenticated",
};

function capabilities(
  claude: RuntimeProviderCapability,
  codex: RuntimeProviderCapability,
): RuntimeCapabilities {
  return { claude, codex };
}

describe("connector provider selection", () => {
  it.each([
    ["claude", ["claude"]],
    ["codex", ["codex"]],
    ["choose", ["claude", "codex"]],
    ["auto", ["claude", "codex"]],
    ["both", ["claude", "codex"]],
  ] as const)("only detects provider candidates allowed by %s", (selection, expected) => {
    expect(connectorProviderCandidates(selection)).toEqual(expected);
  });

  it.each([
    ["claude", connected, missing],
    ["codex", missing, connected],
  ] as const)(
    "shows both providers even when only %s is authenticated",
    async (provider, claude, codex) => {
      const ask = vi.fn(async () => provider);
      await expect(
        selectConnectorProviders("choose", capabilities(claude, codex), ask),
      ).resolves.toEqual([provider]);
      expect(ask).toHaveBeenCalledOnce();
      expect(ask.mock.calls[0]).toBeDefined();
      expect(ask).toHaveBeenCalledWith(expect.stringContaining("CLI executable unavailable"));
    },
  );

  it.each([
    ["1", ["claude"]],
    ["codex", ["codex"]],
    ["3", ["claude", "codex"]],
  ] as const)("lets the operator choose %s when both CLIs are ready", async (answer, expected) => {
    let prompt = "";
    await expect(
      selectConnectorProviders(
        "choose",
        capabilities(connected, connected),
        async (rendered) => {
          prompt = rendered;
          return answer;
        },
      ),
    ).resolves.toEqual(expected);
    expect(prompt).toContain("Claude Code");
    expect(prompt).toContain("Codex CLI");
  });

  it("keeps auto mode for non-interactive all-provider setups", async () => {
    await expect(
      selectConnectorProviders(
        "auto",
        capabilities(connected, connected),
        async () => {
          throw new Error("must not prompt");
        },
      ),
    ).resolves.toEqual(["claude", "codex"]);
  });

  it("fails with provider-specific recovery when an explicit CLI is unavailable", async () => {
    await expect(
      selectConnectorProviders("claude", capabilities(missing, connected)),
    ).rejects.toThrow("Claude Code: CLI executable unavailable");
    await expect(
      selectConnectorProviders("codex", capabilities(connected, signedOut)),
    ).rejects.toThrow("Codex: Not signed in");
  });

  it("fails before pairing when neither CLI is authenticated", async () => {
    await expect(
      selectConnectorProviders("auto", capabilities(missing, signedOut)),
    ).rejects.toThrow("No authenticated Claude Code or Codex CLI is available");
  });

  it("rechecks local setup before connecting both, without carrying the old choice", async () => {
    const detect = vi.fn()
      .mockResolvedValueOnce(capabilities(signedOut, connected))
      .mockResolvedValueOnce(capabilities(connected, connected));
    const ask = vi.fn().mockResolvedValueOnce("4").mockResolvedValueOnce("3");
    await expect(selectConnectorProviders("choose", detect, ask)).resolves.toEqual(["claude", "codex"]);
    expect(detect).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenNthCalledWith(1, expect.stringContaining("Not signed in"));
    expect(ask).toHaveBeenNthCalledWith(2, expect.stringContaining("Claude Code — Available"));
  });

  it("lets the owner inspect and cancel setup when neither provider is available", async () => {
    const ask = vi.fn(async () => "q");
    await expect(selectConnectorProviders("choose", capabilities(missing, signedOut), ask)).rejects.toThrow("no pairing code was consumed");
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("Not signed in"));
  });

  it.each(["both", "choose"] as const)("never silently reduces %s to a single provider", async (selection) => {
    await expect(selectConnectorProviders(selection, capabilities(signedOut, connected), async () => "3")).rejects.toThrow("Claude Code: Not signed in");
  });

  it("rejects an unavailable provider selected from the menu", async () => {
    await expect(selectConnectorProviders("choose", capabilities(missing, connected), async () => "1")).rejects.toThrow("Claude Code: CLI executable unavailable");
  });

  it("does not diagnose a failed check as a signed-out account", async () => {
    await expect(selectConnectorProviders("claude", capabilities({ ...signedOut, reason: "probe_failed" }, connected))).rejects.toThrow("Local CLI check failed");
  });

  it("supports explicit both without a prompt", async () => {
    const ask = vi.fn();
    await expect(selectConnectorProviders("both", capabilities(connected, connected), ask)).resolves.toEqual(["claude", "codex"]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("does not silently choose after an invalid interactive answer", async () => {
    await expect(
      selectConnectorProviders(
        "choose",
        capabilities(connected, connected),
        async () => "no",
      ),
    ).rejects.toThrow("no pairing code was consumed");
  });
});
