import { describe, expect, it, vi } from "vitest";
import type {
  RuntimeCapabilities,
  RuntimeProviderCapability,
} from "../runtime-contract.js";
import { selectConnectorProviders } from "./connector-provider-selection.js";

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
    ["claude", connected, missing],
    ["codex", missing, connected],
  ] as const)(
    "automatically selects the only authenticated %s CLI",
    async (provider, claude, codex) => {
      const ask = vi.fn<() => Promise<string>>();
      await expect(
        selectConnectorProviders("choose", capabilities(claude, codex), ask),
      ).resolves.toEqual([provider]);
      expect(ask).not.toHaveBeenCalled();
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
    ).rejects.toThrow("Claude Code CLI is not installed");
    await expect(
      selectConnectorProviders("codex", capabilities(connected, signedOut)),
    ).rejects.toThrow("Codex CLI is not authenticated");
  });

  it("fails before pairing when neither CLI is authenticated", async () => {
    await expect(
      selectConnectorProviders("choose", capabilities(missing, signedOut)),
    ).rejects.toThrow("No authenticated Claude Code or Codex CLI is available");
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
