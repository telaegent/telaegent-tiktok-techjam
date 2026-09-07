import { describe, expect, it, vi } from "vitest";
import type { ConnectorCredentialService } from "./connector-credentials.js";
import {
  ConnectorDeviceAuthorizationService,
  InMemoryConnectorDeviceAuthorizationRepository,
} from "./connector-device-authorization.js";

const userId = "10000000-0000-4000-8000-000000000001";

function fixture() {
  let now = new Date("2026-09-07T10:00:00.000Z");
  const activateHash = vi.fn(async (_authenticatedUserId: string, connectorInstanceId: unknown) => ({
    connectorInstanceId: String(connectorInstanceId),
    expiresAt: "2026-09-08T10:00:00.000Z",
  }));
  const service = new ConnectorDeviceAuthorizationService(
    new InMemoryConnectorDeviceAuthorizationRepository(
      { activateHash } as unknown as ConnectorCredentialService,
    ),
    "https://telaegent.live",
    3_600,
    60_000,
    3,
    () => now,
  );
  return {
    service,
    activateHash,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

describe("connector device authorization", () => {
  it("requires browser approval before issuing a one-time connector credential", async () => {
    const { service, activateHash, advance } = fixture();
    const authorization = await service.issue("connector_instance_0001", "b".repeat(64));

    expect(authorization.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(authorization.verificationUriComplete).toBe(
      `https://telaegent.live/app/connect-device?code=${authorization.userCode}`,
    );
    await expect(service.exchange(authorization.deviceCode)).resolves.toEqual({
      outcome: "pending",
    });
    await expect(service.exchange(authorization.deviceCode)).resolves.toEqual({
      outcome: "slow_down",
    });

    await expect(service.decide(authorization.userCode, userId, "approve")).resolves.toMatchObject({
      connectorInstanceId: "connector_instance_0001",
      status: "approved",
    });
    advance(3_000);
    await expect(service.exchange(authorization.deviceCode)).resolves.toMatchObject({
      outcome: "approved",
      connector: { connectorInstanceId: "connector_instance_0001" },
    });
    expect(activateHash).toHaveBeenCalledOnce();
    await expect(service.exchange(authorization.deviceCode)).resolves.toMatchObject({
      outcome: "approved",
      connector: { connectorInstanceId: "connector_instance_0001" },
    });
    expect(activateHash).toHaveBeenCalledOnce();

    advance(60_001);
    await expect(service.exchange(authorization.deviceCode)).resolves.toMatchObject({
      outcome: "approved",
      connector: { connectorInstanceId: "connector_instance_0001" },
    });
    expect(activateHash).toHaveBeenCalledOnce();

    advance(57_000);
    await expect(service.exchange(authorization.deviceCode)).resolves.toEqual({
      outcome: "consumed",
    });
  });

  it("does not allow an approved request to be claimed after expiry", async () => {
    const { service, activateHash, advance } = fixture();
    const authorization = await service.issue("connector_instance_0002", "c".repeat(64));
    await service.decide(authorization.userCode, userId, "approve");
    advance(60_001);

    await expect(service.exchange(authorization.deviceCode)).resolves.toEqual({
      outcome: "expired",
    });
    expect(activateHash).not.toHaveBeenCalled();
  });

  it("makes denial terminal and rejects malformed public codes", async () => {
    const { service, advance } = fixture();
    const authorization = await service.issue("connector_instance_0003", "d".repeat(64));
    await service.decide(authorization.userCode.toLowerCase(), userId, "deny");
    advance(3_000);
    await expect(service.exchange(authorization.deviceCode)).resolves.toEqual({
      outcome: "denied",
    });
    expect(() => service.inspect("not-a-code")).toThrow(/invalid/);
    await expect(service.exchange("not-a-device-code")).resolves.toEqual({
      outcome: "expired",
    });
  });

  it("does not consume approval when credential activation fails and allows a retry", async () => {
    let attempts = 0;
    const activateHash = vi.fn(async (_userId: string, connectorInstanceId: unknown) => {
      attempts += 1;
      if (attempts === 1) throw new Error("credential persistence unavailable");
      return {
        connectorInstanceId: String(connectorInstanceId),
        expiresAt: "2026-09-08T10:00:00.000Z",
      };
    });
    const service = new ConnectorDeviceAuthorizationService(
      new InMemoryConnectorDeviceAuthorizationRepository(
        { activateHash } as unknown as ConnectorCredentialService,
      ),
      "https://telaegent.live",
      3_600,
    );
    const authorization = await service.issue("connector_instance_0004", "e".repeat(64));
    await service.decide(authorization.userCode, userId, "approve");

    await expect(service.exchange(authorization.deviceCode)).rejects.toThrow(
      "credential persistence unavailable",
    );
    await expect(service.exchange(authorization.deviceCode)).resolves.toMatchObject({
      outcome: "approved",
      connector: { connectorInstanceId: "connector_instance_0004" },
    });
    expect(activateHash).toHaveBeenCalledTimes(2);
  });
});
