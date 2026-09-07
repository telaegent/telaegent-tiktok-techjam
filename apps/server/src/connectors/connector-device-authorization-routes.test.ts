import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { ConnectorPrincipal } from "../repository-proof/contract.js";
import {
  ConnectorCredentialService,
  createConnectorPrincipalResolver,
  type ConnectorCredentialRepository,
  type ConnectorSetupStatus,
} from "./connector-credentials.js";
import {
  ConnectorDeviceAuthorizationService,
  InMemoryConnectorDeviceAuthorizationRepository,
} from "./connector-device-authorization.js";
import { LongPollConnectorJobRelay } from "./long-poll-job-relay.js";

const userId = "10000000-0000-4000-8000-000000000001";

class MemoryCredentials implements ConnectorCredentialRepository {
  readonly principals = new Map<string, ConnectorPrincipal>();
  async create(input: { authenticatedUserId: string; connectorInstanceId: string; tokenHashHex: string }) {
    this.principals.set(input.tokenHashHex, {
      authenticatedUserId: input.authenticatedUserId,
      connectorInstanceId: input.connectorInstanceId,
    });
    return true;
  }
  async authenticate(hash: string) { return this.principals.get(hash) ?? null; }
  async revoke(input: ConnectorPrincipal) {
    for (const [hash, principal] of this.principals) {
      if (principal.authenticatedUserId === input.authenticatedUserId && principal.connectorInstanceId === input.connectorInstanceId) {
        this.principals.delete(hash);
      }
    }
    return true;
  }
  async loadSetupStatus(): Promise<ConnectorSetupStatus | null> { return null; }
}

describe("connector device authorization HTTP flow", () => {
  it("approves in the authenticated browser, returns the bearer only to the CLI, and disconnects by repository", async () => {
    const credentialRepository = new MemoryCredentials();
    const credentials = new ConnectorCredentialService(credentialRepository, 3_600);
    const deviceAuthorizations = new ConnectorDeviceAuthorizationService(
      new InMemoryConnectorDeviceAuthorizationRepository(),
      credentials,
      "https://telaegent.live",
    );
    const disconnectRepository = vi.fn(async (_principal: ConnectorPrincipal, githubRepositoryId: string) => ({
      disconnect: {
        projectId: "30000000-0000-4000-8000-000000000001",
        githubRepositoryId,
        repositoryAccessStatus: "revalidation_required",
        membershipStatus: "suspended",
        bindingStatus: "stopped",
        disconnectedAt: "2026-09-07T10:00:00.000Z",
        changed: true,
      },
    }));
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
        deviceAuthorizations,
        authenticatedUserId: async () => userId,
        resolveConnectorPrincipal: createConnectorPrincipalResolver(credentials),
        disconnectRepository,
      },
    );

    const issued = await app.inject({
      method: "POST",
      url: "/api/connectors/device-authorizations",
      payload: { connectorInstanceId: "connector_instance_0001" },
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.headers["cache-control"]).toBe("no-store, max-age=0");
    const device = issued.json().deviceAuthorization;
    expect(JSON.stringify(issued.json())).not.toContain("credential");

    const pending = await app.inject({
      method: "POST",
      url: "/api/connectors/device-authorizations/token",
      payload: { deviceCode: device.deviceCode },
    });
    expect(pending.statusCode).toBe(202);

    const approved = await app.inject({
      method: "POST",
      url: `/api/connectors/device-authorizations/${device.userCode}/decision`,
      payload: { decision: "approve" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().authorization.status).toBe("approved");
    expect(JSON.stringify(approved.json())).not.toContain("credential");

    const token = await app.inject({
      method: "POST",
      url: "/api/connectors/device-authorizations/token",
      payload: { deviceCode: device.deviceCode },
    });
    expect(token.statusCode).toBe(201);
    const credential = token.json().connector.credential as string;
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(credentialRepository.principals.has(createHash("sha256").update(credential).digest("hex"))).toBe(true);

    const disconnected = await app.inject({
      method: "POST",
      url: "/api/connectors/repositories/123456789/disconnect",
      headers: { authorization: `Bearer ${credential}` },
      payload: {},
    });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json().disconnect).toMatchObject({
      githubRepositoryId: "123456789",
      membershipStatus: "suspended",
      bindingStatus: "stopped",
    });
    expect(disconnectRepository).toHaveBeenCalledWith(
      { authenticatedUserId: userId, connectorInstanceId: "connector_instance_0001" },
      "123456789",
    );
    await app.close();
  });
});
