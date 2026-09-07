import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { authorizeConnectorDevice, createConnectorInstanceId } from "./connector-device-client.js";

describe("connector device client", () => {
  it("recovers an approved credential when the commit response is lost at expiry", async () => {
    const connectorInstanceId = createConnectorInstanceId();
    const deviceCode = "d".repeat(43);
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        deviceAuthorization: {
          deviceCode,
          userCode: "ABCD-EFGH",
          verificationUri: "https://attacker.example/phish",
          verificationUriComplete: "https://attacker.example/phish?code=ABCD-EFGH",
          expiresAt: "2026-09-07T10:05:00.000Z",
          intervalSeconds: 3,
        },
      }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ outcome: "pending" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }))
      // Simulate the server committing activation before the response is lost.
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        outcome: "approved",
        connector: {
          connectorInstanceId,
          expiresAt: "2026-09-08T10:00:00.000Z",
        },
      }), { status: 201, headers: { "content-type": "application/json" } }));
    const openBrowser = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);
    const now = vi.fn()
      .mockReturnValueOnce(Date.parse("2026-09-07T10:04:55.000Z"))
      .mockReturnValueOnce(Date.parse("2026-09-07T10:04:58.000Z"))
      .mockReturnValueOnce(Date.parse("2026-09-07T10:05:01.000Z"));

    const authorized = await authorizeConnectorDevice(
      "https://telaegent.live",
      connectorInstanceId,
      fetchImplementation,
      { now, sleep, openBrowser },
    );
    expect(authorized).toMatchObject({ connectorInstanceId });
    expect(authorized.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(openBrowser).toHaveBeenCalledWith(
      "https://telaegent.live/app/connect-device?code=ABCD-EFGH",
    );
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    const issueBody = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body));
    expect(issueBody.credentialHash).toBe(
      createHash("sha256").update(authorized.credential).digest("hex"),
    );
    expect(fetchImplementation.mock.calls[1]?.[0].toString()).toBe(
      "https://telaegent.live/api/connectors/device-authorizations/token",
    );
    expect(now).toHaveBeenCalledTimes(3);
  });

  it("stops polling when the consumed-response recovery window ends", async () => {
    const connectorInstanceId = createConnectorInstanceId();
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({
        deviceAuthorization: {
          deviceCode: "d".repeat(43),
          userCode: "ABCD-EFGH",
          verificationUri: "https://telaegent.live/app/connect-device",
          verificationUriComplete: "https://telaegent.live/app/connect-device?code=ABCD-EFGH",
          expiresAt: "2026-09-07T10:05:00.000Z",
          intervalSeconds: 3,
        },
      }), { status: 201, headers: { "content-type": "application/json" } }),
    );
    const sleep = vi.fn(async () => undefined);

    await expect(authorizeConnectorDevice(
      "https://telaegent.live",
      connectorInstanceId,
      fetchImplementation,
      {
        now: () => Date.parse("2026-09-07T10:06:00.000Z"),
        sleep,
        openBrowser: async () => undefined,
      },
    )).rejects.toThrow("Telaegent device authorization expired");
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
