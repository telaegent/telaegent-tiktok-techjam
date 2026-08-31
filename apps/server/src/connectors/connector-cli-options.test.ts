import { describe, expect, it } from "vitest";
import { parseConnectorCliOptions } from "./connector-cli-options.js";

describe("connector CLI options", () => {
  it("defaults to the current repository and all authenticated providers", () => {
    expect(parseConnectorCliOptions(["connect"])).toEqual({
      workspaceCandidate: ".",
      provider: "auto",
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
      ])).toEqual({ workspaceCandidate: "D:\\repo", provider });
    },
  );

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
