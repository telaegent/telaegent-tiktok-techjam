import { describe, expect, it } from "vitest";
import { connectorPresence } from "./connector-presence";

describe("connectorPresence", () => {
  it("reports connected when any verified project has a live connector", () => {
    expect(
      connectorPresence(
        [{ connectorLive: false }, { connectorLive: true }],
        false,
      ),
    ).toBe("connected");
  });

  it("reports checking while initial project discovery is in progress", () => {
    expect(connectorPresence([], true)).toBe("checking");
  });

  it("reports disconnected when no connector is live", () => {
    expect(connectorPresence([{ connectorLive: false }], false)).toBe(
      "disconnected",
    );
  });
});
