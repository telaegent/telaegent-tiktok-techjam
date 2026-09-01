import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createApp } from "../app.js";
import {
  ConnectorCredentialService,
  createConnectorPrincipalResolver,
  type ConnectorCredentialRepository,
  type ConnectorSetupStatus,
} from "./connector-credentials.js";
import { ConnectorPairingService } from "./connector-pairing.js";
import { LongPollConnectorJobRelay } from "./long-poll-job-relay.js";

const userId = "10000000-0000-4000-8000-000000000001";
const bindingId = "20000000-0000-4000-8000-000000000001";
const repositoryId = "123456789";

class MemoryCredentialRepository implements ConnectorCredentialRepository {
  private readonly principals = new Map<string, {
    authenticatedUserId: string;
    connectorInstanceId: string;
  }>();

  async create(input: {
    authenticatedUserId: string;
    connectorInstanceId: string;
    tokenHashHex: string;
  }): Promise<boolean> {
    this.principals.set(input.tokenHashHex, {
      authenticatedUserId: input.authenticatedUserId,
      connectorInstanceId: input.connectorInstanceId,
    });
    return true;
  }

  async authenticate(tokenHashHex: string) {
    return this.principals.get(tokenHashHex) ?? null;
  }

  async revoke(): Promise<boolean> {
    return true;
  }

  async loadSetupStatus(): Promise<ConnectorSetupStatus | null> {
    const principal = this.principals.values().next().value;
    if (!principal) return null;
    return {
      connectorInstanceId: principal.connectorInstanceId,
      credential: {
        status: "active",
        expiresAt: "2026-09-02T00:00:00.000Z",
        lastSeenAt: null,
      },
      bindings: [{
        connectorBindingId: bindingId,
        projectId: "30000000-0000-4000-8000-000000000001",
        githubRepositoryId: repositoryId,
        repositoryFullName: "telaegent/demo",
        visibility: "private",
        defaultBranch: "main",
        currentBranch: "main",
        commitSha: "a".repeat(40),
        repositoryPermission: "write",
        repositoryAccessStatus: "verified",
        membershipStatus: "active",
        bindingStatus: "ready",
        verifiedAt: "2026-09-01T00:00:00.000Z",
        bindingLastSeenAt: null,
        unavailableReason: null,
      }],
      bindingsTruncated: false,
    };
  }
}

describe("connector pairing HTTP flow", () => {
  it("exchanges a browser-issued code exactly once and keeps the bearer out of the browser response", async () => {
    const credentials = new ConnectorCredentialService(
      new MemoryCredentialRepository(),
      3_600,
    );
    const pairings = new ConnectorPairingService();
    const relay = new LongPollConnectorJobRelay();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        relay,
        credentials,
        pairings,
        authenticatedUserId: async () => userId,
        resolveConnectorPrincipal: createConnectorPrincipalResolver(credentials),
      },
    );

    const issued = await app.inject({
      method: "POST",
      url: "/api/connectors/pairings",
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.headers["cache-control"]).toBe("no-store, max-age=0");
    const pairing = issued.json().pairing;
    expect(pairing).toMatchObject({
      pairingCode: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      connectorInstanceId: expect.stringMatching(/^connector_[a-f0-9]{32}$/),
    });
    expect(JSON.stringify(issued.json())).not.toContain("credential");

    const exchanged = await app.inject({
      method: "POST",
      url: "/api/connectors/pairings/exchange",
      payload: { pairingCode: pairing.pairingCode },
    });
    expect(exchanged.statusCode).toBe(201);
    expect(exchanged.headers["cache-control"]).toBe("no-store, max-age=0");
    const connector = exchanged.json().connector;
    expect(connector).toMatchObject({
      credential: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      connectorInstanceId: pairing.connectorInstanceId,
    });

    const replay = await app.inject({
      method: "POST",
      url: "/api/connectors/pairings/exchange",
      payload: { pairingCode: pairing.pairingCode },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ code: "AUTHENTICATION_FAILED" });

    const session = await app.inject({
      method: "GET",
      url: "/api/connectors/session",
      headers: { authorization: `Bearer ${connector.credential}` },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().connector).toEqual({
      authenticatedUserId: userId,
      connectorInstanceId: pairing.connectorInstanceId,
    });

    relay.registerBinding(session.json().connector, bindingId, repositoryId);
    const ready = await app.inject({
      method: "POST",
      url: `/api/connectors/bindings/${bindingId}/ready`,
      headers: { authorization: `Bearer ${connector.credential}` },
      payload: {},
    });
    expect(ready.statusCode).toBe(204);

    const status = await app.inject({
      method: "GET",
      url: `/api/connectors/installations/${pairing.connectorInstanceId}/status`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().connector).toMatchObject({
      connectorInstanceId: pairing.connectorInstanceId,
      liveReady: true,
    });
    await app.close();
  });
});
