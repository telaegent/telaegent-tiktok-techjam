import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderSetup } from "./ProviderSetup";
import type { RuntimeModelCatalogue } from "./api";

const codexOnly: RuntimeModelCatalogue = {
  providers: [{ provider: "codex", models: ["codex-model"], defaultModel: "codex-model" }],
  efforts: [],
  defaultEffort: "medium",
};

describe("provider setup", () => {
  it("offers setup for Claude when only Codex is connected", () => {
    const html = renderToStaticMarkup(<ProviderSetup catalogue={codexOnly} availabilityKnown onRefresh={() => {}} />);
    expect(html).toContain("Manage coding agents");
    expect(html).toContain("Claude Code</strong><span>Not connected through your connector");
    expect(html).toContain("Codex</strong><span>Connected locally");
    expect(html).toContain("tlg connect --provider choose");
    expect(html).toContain("Both providers");
    expect(html).toContain("Existing private drafts keep their original provider");
  });

  it("does not claim local installation or connection status when availability is unknown", () => {
    const html = renderToStaticMarkup(<ProviderSetup catalogue={codexOnly} availabilityKnown={false} onRefresh={() => {}} />);
    expect(html.match(/Availability unknown/g)).toHaveLength(2);
    expect(html).not.toContain("Connected locally");
    expect(html).not.toContain("Not installed");
  });
});
