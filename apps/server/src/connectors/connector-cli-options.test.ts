import { describe, expect, it } from "vitest";
import { parseConnectorCliOptions } from "./connector-cli-options.js";

describe("connector CLI options", () => {
  it("defaults to the current repository and all authenticated providers", () => {
    expect(parseConnectorCliOptions(["connect"])).toEqual({
      workspaceCandidate: ".",
      provider: "auto",
      probeOnly: false,
    });
  });

  it.each(["codex", "claude"] as const)(
    "allows the local operator to select %s explicitly",
    (provider) => {
      expect(parseConnectorCliOptions([
        "connect",
        "D:\\repo",
        "--provider",
        provider,
      ])).toEqual({ workspaceCandidate: "D:\\repo", provider, probeOnly: false });
    },
  );

  it("supports an explicit live-probe-only run", () => {
    expect(parseConnectorCliOptions([
      "connect",
      "--probe-only",
      "/repo",
      "--provider",
      "codex",
    ])).toEqual({ workspaceCandidate: "/repo", provider: "codex", probeOnly: true });
  });

  it.each([
    [],
    ["start"],
    ["connect", "one", "two"],
    ["connect", "--provider"],
    ["connect", "--provider", "other"],
    ["connect", "--unknown"],
  ])("fails closed for invalid arguments: %j", (argv) => {
    expect(() => parseConnectorCliOptions(argv)).toThrow();
  });
});
