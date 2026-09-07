import { describe, expect, it, vi } from "vitest";
import { authorizeConnectorDevice, createConnectorInstanceId } from "./connector-device-client.js";

describe("connector device client", () => {
  it("opens the complete browser URL and polls until the approved credential arrives", async () => {
    const connectorInstanceId = createConnectorInstanceId();
    const deviceCode = "d".repeat(43);
    const credential = "c".repeat(43);
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        deviceAuthorization: {
          deviceCode,
          userCode: "ABCD-EFGH",
          verificationUri: "https://telaegent.live/app/connect-device",
          verificationUriComplete: "https://telaegent.live/app/connect-device?code=ABCD-EFGH",
          expiresAt: "2026-09-07T10:05:00.000Z",
          intervalSeconds: 3,
        },
      }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ outcome: "pending" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        outcome: "approved",
        connector: {
          credential,
          connectorInstanceId,
          expiresAt: "2026-09-08T10:00:00.000Z",
        },
      }), { status: 201, headers: { "content-type": "application/json" } }));
    const openBrowser = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);

    await expect(authorizeConnectorDevice(
      "https://telaegent.live",
      connectorInstanceId,
      fetchImplementation,
      { now: () => Date.parse("2026-09-07T10:00:00.000Z"), sleep, openBrowser },
    )).resolves.toMatchObject({ credential, connectorInstanceId });

    expect(openBrowser).toHaveBeenCalledWith(
      "https://telaegent.live/app/connect-device?code=ABCD-EFGH",
    );
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(fetchImplementation.mock.calls[1]?.[0].toString()).toBe(
      "https://telaegent.live/api/connectors/device-authorizations/token",
    );
  });
});
