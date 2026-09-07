import { describe, expect, it } from "vitest";
import type { RuntimeModelCatalogue } from "./api";
import { selectAvailableProvider } from "./runtime-selection";

const catalogue = (providers: RuntimeModelCatalogue["providers"]): RuntimeModelCatalogue => ({
  providers,
  efforts: ["low", "medium", "high"],
  defaultEffort: "medium",
});

describe("runtime provider selection", () => {
  it("selects the first available provider only before the owner has a choice", () => {
    expect(selectAvailableProvider(catalogue([
      { provider: "codex", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol" },
    ]), null)).toBe("codex");
  });

  it("requires a visible choice when the selected provider goes offline", () => {
    const codexOnly = catalogue([
      { provider: "codex", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol" },
    ]);
    expect(selectAvailableProvider(codexOnly, "claude")).toBeNull();
    expect(selectAvailableProvider(codexOnly, "codex")).toBe("codex");
  });

  it("preserves a still-available owner choice and refuses an empty catalogue", () => {
    const both = catalogue([
      { provider: "claude", models: ["opus"], defaultModel: "opus" },
      { provider: "codex", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol" },
    ]);
    expect(selectAvailableProvider(both, "codex")).toBe("codex");
    expect(selectAvailableProvider(catalogue([]), "claude")).toBeNull();
  });
});
