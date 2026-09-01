import { describe, expect, it } from "vitest";
import { buildConnectorCommand } from "./connector-command";

const credential = {
  connectorInstanceId: "connectorinstance1234567890",
  credential: "credential_1234567890123456789012345678901234567890",
  expiresAt: "2026-09-01T12:00:00.000Z",
};

describe("connector onboarding command", () => {
  it("runs the published connector against the terminal's current repository", () => {
    expect(buildConnectorCommand("https://telaegent.live", credential)).toBe(
      "npx --yes @telaegent/connector@0.1.0 connect . --url https://telaegent.live " +
        `--instance-id ${credential.connectorInstanceId} --credential ${credential.credential}`,
    );
  });

  it.each([
    ["https://telaegent.live/path", credential],
    ["https://telaegent.live", { ...credential, connectorInstanceId: "bad id" }],
    ["https://telaegent.live", { ...credential, credential: "too-short" }],
  ])("rejects values that would make an unsafe shell command", (origin, value) => {
    expect(() => buildConnectorCommand(origin, value)).toThrow();
  });
});
