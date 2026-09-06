import { describe, expect, it } from "vitest";
import type { RuntimeModelCatalogue } from "./api";
import { selectAvailableProvider } from "./runtime-selection";

const catalogue = (providers: RuntimeModelCatalogue["providers"]): RuntimeModelCatalogue => ({
  providers,
  efforts: ["low", "medium", "high"],
  defaultEffort: "medium",
});

describe("runtime provider selection", () => {
  it("falls back to the first provider the connected machine can actually run", () => {
    expect(selectAvailableProvider(catalogue([
      { provider: "codex", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol" },
    ]), "claude")).toBe("codex");
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
