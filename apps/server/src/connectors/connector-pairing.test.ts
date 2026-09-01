import { describe, expect, it } from "vitest";
import { ConnectorPairingService } from "./connector-pairing.js";

const userId = "10000000-0000-4000-8000-000000000001";
const secondUserId = "10000000-0000-4000-8000-000000000002";

describe("connector one-command pairing", () => {
  it("issues a bounded high-entropy command code and consumes it once", () => {
    const service = new ConnectorPairingService();
    const pairing = service.issue(userId);

    expect(pairing.pairingCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pairing.connectorInstanceId).toMatch(/^connector_[a-f0-9]{32}$/);
    expect(service.consume(pairing.pairingCode)).toEqual({
      authenticatedUserId: userId,
      connectorInstanceId: pairing.connectorInstanceId,
    });
    expect(() => service.consume(pairing.pairingCode)).toThrow(
      "invalid, expired, or already used",
    );
  });

  it("rejects expired and malformed codes without revealing which case occurred", () => {
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const service = new ConnectorPairingService(
      30_000,
      10,
      () => new Date(nowMs),
    );
    const pairing = service.issue(userId);
    nowMs += 30_001;

    expect(() => service.consume(pairing.pairingCode)).toThrow(
      "invalid, expired, or already used",
    );
    expect(() => service.consume("not-a-code")).toThrow(
      "invalid, expired, or already used",
    );
  });

  it("fails closed at capacity until expired entries are pruned", () => {
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const service = new ConnectorPairingService(
      30_000,
      1,
      () => new Date(nowMs),
    );
    service.issue(userId);
    expect(() => service.issue(secondUserId)).toThrow("temporarily unavailable");
    nowMs += 30_001;
    expect(service.issue(secondUserId).pairingCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rotates an unconsumed code and tracks post-probe live readiness", () => {
    const service = new ConnectorPairingService();
    const oldPairing = service.issue(userId);
    const currentPairing = service.issue(userId);

    expect(() => service.consume(oldPairing.pairingCode)).toThrow(
      "invalid, expired, or already used",
    );
    expect(service.isLive(userId, currentPairing.connectorInstanceId)).toBe(false);
    service.markLive(
      userId,
      currentPairing.connectorInstanceId,
      "20000000-0000-4000-8000-000000000001",
    );
    expect(service.isLive(userId, currentPairing.connectorInstanceId)).toBe(true);
  });

  it("stops reporting an installation as live when its heartbeat expires", () => {
    let nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const service = new ConnectorPairingService(
      30_000,
      10,
      () => new Date(nowMs),
      60_000,
    );
    const pairing = service.issue(userId);
    service.markLive(
      userId,
      pairing.connectorInstanceId,
      "20000000-0000-4000-8000-000000000001",
    );

    nowMs += 59_999;
    expect(service.isLive(userId, pairing.connectorInstanceId)).toBe(true);
    nowMs += 1;
    expect(service.isLive(userId, pairing.connectorInstanceId)).toBe(false);
  });

  it("evicts the oldest live marker at bounded capacity", () => {
    const service = new ConnectorPairingService(30_000, 1);
    const firstInstance = `connector_${"a".repeat(32)}`;
    const secondInstance = `connector_${"b".repeat(32)}`;
    service.markLive(
      userId,
      firstInstance,
      "20000000-0000-4000-8000-000000000001",
    );
    service.markLive(
      secondUserId,
      secondInstance,
      "20000000-0000-4000-8000-000000000002",
    );

    expect(service.isLive(userId, firstInstance)).toBe(false);
    expect(service.isLive(secondUserId, secondInstance)).toBe(true);
  });
});
