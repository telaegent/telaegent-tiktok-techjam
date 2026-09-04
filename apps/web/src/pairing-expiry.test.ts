import { describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_PAIRING_POLL_INTERVAL_MS,
  CONNECTOR_PAIRING_STATUS_GRACE_MS,
  CONNECTOR_SETUP_MAX_POLL_INTERVAL_MS,
  CONNECTOR_SETUP_POLL_WINDOW_MS,
  ConnectorSetupPollTracker,
  connectorSetupPhase,
  nextPairingPollDelay,
  type ConnectorSetupSnapshot,
} from "./pairing-expiry";

const pairingExpiresAt = "2026-09-04T12:05:00.000Z";
const pairingExpiresMs = Date.parse(pairingExpiresAt);

function snapshot(
  overrides: Partial<ConnectorSetupSnapshot> = {},
): ConnectorSetupSnapshot {
  return {
    liveReady: false,
    credential: null,
    bindings: [],
    ...overrides,
  };
}

function activeCredential(expiresAt = "2026-09-04T13:00:00.000Z") {
  return { status: "active" as const, expiresAt };
}

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

describe("connectorSetupPhase", () => {
  it("treats a null credential as not exchanged yet, not inactive", () => {
    expect(connectorSetupPhase(snapshot({ credential: null }))).toBe("not_ready");
  });

  it("keeps an active but incomplete connector pending", () => {
    expect(
      connectorSetupPhase(snapshot({ credential: activeCredential() })),
    ).toBe("not_ready");
  });

  it("recognizes ready and explicitly inactive connectors", () => {
    expect(
      connectorSetupPhase(
        snapshot({
          liveReady: true,
          credential: activeCredential(),
          bindings: [
            {
              bindingStatus: "ready",
              membershipStatus: "active",
              repositoryAccessStatus: "verified",
            },
          ],
        }),
      ),
    ).toBe("ready");
    expect(
      connectorSetupPhase(
        snapshot({
          credential: {
            status: "revoked",
            expiresAt: "2026-09-04T13:00:00.000Z",
          },
        }),
      ),
    ).toBe("credential_inactive");
  });
});

describe("ConnectorSetupPollTracker", () => {
  it("gives a near-expiry exchange time to become visible", async () => {
    const tracker = new ConnectorSetupPollTracker(pairingExpiresAt);
    const loadStatus = vi.fn(async () => snapshot({ credential: null }));

    await expect(
      tracker.check(loadStatus, () => pairingExpiresMs + 1),
    ).resolves.toEqual({
      kind: "wait",
      delayMs: CONNECTOR_PAIRING_POLL_INTERVAL_MS,
    });
    await expect(
      tracker.check(
        loadStatus,
        () => pairingExpiresMs + CONNECTOR_PAIRING_STATUS_GRACE_MS,
      ),
    ).resolves.toEqual({ kind: "stop", reason: "pairing_expired" });
  });

  it("tolerates a transient status failure during the expiry grace period", async () => {
    const tracker = new ConnectorSetupPollTracker(pairingExpiresAt);
    const loadStatus = vi.fn(async () => {
      throw new Error("temporary outage");
    });

    await expect(
      tracker.check(loadStatus, () => pairingExpiresMs + 1),
    ).resolves.toEqual({
      kind: "wait",
      delayMs: CONNECTOR_PAIRING_POLL_INTERVAL_MS,
    });
  });

  it("crosses from pairing to credential state after expiry", async () => {
    const tracker = new ConnectorSetupPollTracker(pairingExpiresAt);
    const loadStatus = vi
      .fn<() => Promise<ConnectorSetupSnapshot>>()
      .mockResolvedValueOnce(snapshot({ credential: null }))
      .mockResolvedValueOnce(snapshot({ credential: activeCredential() }));

    await expect(
      tracker.check(loadStatus, () => pairingExpiresMs - 1),
    ).resolves.toMatchObject({ kind: "wait" });
    await expect(
      tracker.check(loadStatus, () => pairingExpiresMs + 1),
    ).resolves.toEqual({
      kind: "wait",
      delayMs: CONNECTOR_PAIRING_POLL_INTERVAL_MS,
    });
  });

  it("retains an observed credential across a transient status failure", async () => {
    const tracker = new ConnectorSetupPollTracker(pairingExpiresAt);
    const loadStatus = vi
      .fn<() => Promise<ConnectorSetupSnapshot>>()
      .mockResolvedValueOnce(snapshot({ credential: activeCredential() }))
      .mockRejectedValueOnce(new Error("temporary outage"));

    await tracker.check(loadStatus, () => pairingExpiresMs + 1);
    await expect(
      tracker.check(loadStatus, () => pairingExpiresMs + 2),
    ).resolves.toEqual({
      kind: "wait",
      delayMs: CONNECTOR_PAIRING_POLL_INTERVAL_MS * 2,
    });
  });

  it("backs off and bounds post-exchange automatic polling", async () => {
    const tracker = new ConnectorSetupPollTracker(pairingExpiresAt);
    const loadStatus = vi.fn(async () =>
      snapshot({ credential: activeCredential("2026-09-20T00:00:00.000Z") }),
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await tracker.check(loadStatus, () => pairingExpiresMs + attempt);
    }
    await expect(
      tracker.check(loadStatus, () => pairingExpiresMs + 5),
    ).resolves.toEqual({
      kind: "wait",
      delayMs: CONNECTOR_SETUP_MAX_POLL_INTERVAL_MS,
    });
    await expect(
      tracker.check(
        loadStatus,
        () => pairingExpiresMs + CONNECTOR_SETUP_POLL_WINDOW_MS,
      ),
    ).resolves.toEqual({ kind: "stop", reason: "setup_timed_out" });
  });

  it("returns ready and stops on credential revocation", async () => {
    const readyTracker = new ConnectorSetupPollTracker(pairingExpiresAt);
    await expect(
      readyTracker.check(
        async () =>
          snapshot({
            liveReady: true,
            credential: activeCredential(),
            bindings: [
              {
                bindingStatus: "ready",
                membershipStatus: "active",
                repositoryAccessStatus: "verified",
              },
            ],
          }),
        () => pairingExpiresMs + 1,
      ),
    ).resolves.toEqual({ kind: "ready" });

    const revokedTracker = new ConnectorSetupPollTracker(pairingExpiresAt);
    await expect(
      revokedTracker.check(
        async () =>
          snapshot({
            credential: {
              status: "revoked",
              expiresAt: "2026-09-04T13:00:00.000Z",
            },
          }),
        () => pairingExpiresMs + 1,
      ),
    ).resolves.toEqual({ kind: "stop", reason: "credential_inactive" });
  });
});
