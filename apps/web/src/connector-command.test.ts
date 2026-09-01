import { describe, expect, it } from "vitest";
import { buildConnectorCommand } from "./connector-command";

const pairingCode = "A".repeat(43);
const pairing = {
  connectorInstanceId: "connectorinstance1234567890",
  pairingCode,
  expiresAt: "2026-09-01T12:00:00.000Z",
};

describe("connector onboarding command", () => {
  it("runs the published connector against the terminal's current repository", () => {
    expect(buildConnectorCommand("https://telaegent.live", pairing)).toBe(
      "npx --yes @telaegent/connector@0.1.5 connect . --url https://telaegent.live " +
        `--pair ${pairing.pairingCode}`,
    );
  });

  it.each([
    ["https://telaegent.live/path", pairing],
    ["https://telaegent.live", { ...pairing, connectorInstanceId: "bad id" }],
    ["https://telaegent.live", { ...pairing, pairingCode: "too-short" }],
  ])("rejects values that would make an unsafe shell command", (origin, value) => {
    expect(() => buildConnectorCommand(origin, value)).toThrow();
  });
});
