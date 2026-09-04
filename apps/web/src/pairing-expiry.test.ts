import { describe, expect, it } from "vitest";
import {
  CONNECTOR_PAIRING_POLL_INTERVAL_MS,
  nextPairingPollDelay,
} from "./pairing-expiry";

describe("nextPairingPollDelay", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");

  it("uses the normal interval while the pairing remains valid", () => {
    expect(nextPairingPollDelay("2026-09-04T12:01:00.000Z", now)).toBe(
      CONNECTOR_PAIRING_POLL_INTERVAL_MS,
    );
  });

  it("stops exactly at expiry and rejects invalid timestamps", () => {
    expect(nextPairingPollDelay("2026-09-04T12:00:00.000Z", now)).toBeNull();
    expect(nextPairingPollDelay("not-a-date", now)).toBeNull();
  });

  it("shortens the final delay so polling stops at the deadline", () => {
    expect(nextPairingPollDelay("2026-09-04T12:00:00.250Z", now)).toBe(250);
  });
});
