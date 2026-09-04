import { describe, expect, it } from "vitest";
import {
  CONNECTOR_PAIRING_POLL_INTERVAL_MS,
  nextConnectorSetupPollDelay,
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

describe("nextConnectorSetupPollDelay", () => {
  const now = Date.parse("2026-09-04T12:05:00.000Z");

  it("keeps polling after pairing expiry once an active credential exists", () => {
    expect(
      nextConnectorSetupPollDelay(
        "2026-09-04T12:04:59.000Z",
        {
          status: "active",
          expiresAt: "2026-09-04T13:00:00.000Z",
        },
        now,
      ),
    ).toBe(CONNECTOR_PAIRING_POLL_INTERVAL_MS);
  });

  it("still stops an unexchanged pairing at its own expiry", () => {
    expect(
      nextConnectorSetupPollDelay(
        "2026-09-04T12:05:00.000Z",
        null,
        now,
      ),
    ).toBeNull();
  });

  it("stops when the issued credential expires or is revoked", () => {
    expect(
      nextConnectorSetupPollDelay(
        "2026-09-04T12:10:00.000Z",
        {
          status: "active",
          expiresAt: "2026-09-04T12:05:00.000Z",
        },
        now,
      ),
    ).toBeNull();
    expect(
      nextConnectorSetupPollDelay(
        "2026-09-04T12:10:00.000Z",
        {
          status: "revoked",
          expiresAt: "2026-09-04T13:00:00.000Z",
        },
        now,
      ),
    ).toBeNull();
  });
});
