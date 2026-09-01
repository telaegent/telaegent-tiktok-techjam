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

  it("accepts one-command connector settings without requiring shell-specific environment syntax", () => {
    expect(parseConnectorCliOptions([
      "connect",
      ".",
      "--url",
      "https://telaegent.live",
      "--instance-id",
      "connector-instance-id",
      "--credential",
      "connector-credential",
    ])).toEqual({
      workspaceCandidate: ".",
      provider: "auto",
      probeOnly: false,
      serverOrigin: "https://telaegent.live",
      connectorInstanceId: "connector-instance-id",
      credential: "connector-credential",
    });
  });

  it("accepts a one-time pairing code without exposing a connector bearer", () => {
    expect(parseConnectorCliOptions([
      "connect",
      ".",
      "--url",
      "https://telaegent.live",
      "--pair",
      "pairing-code",
    ])).toEqual({
      workspaceCandidate: ".",
      provider: "auto",
      probeOnly: false,
      serverOrigin: "https://telaegent.live",
      pairingCode: "pairing-code",
    });
  });

  it.each([
    [],
    ["start"],
    ["connect", "one", "two"],
    ["connect", "--provider"],
    ["connect", "--provider", "other"],
    ["connect", "--url"],
    ["connect", "--instance-id", "--probe-only"],
    ["connect", "--credential"],
    ["connect", "--pair"],
    ["connect", "--pair", "pair", "--credential", "bearer"],
    ["connect", "--unknown"],
  ])("fails closed for invalid arguments: %j", (argv) => {
    expect(() => parseConnectorCliOptions(argv)).toThrow();
  });
});
