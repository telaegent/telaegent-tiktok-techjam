import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { ConnectorPrincipal } from "../repository-proof/contract.js";
import {
  ConnectorCredentialService,
  createConnectorPrincipalResolver,
  type ConnectorCredentialRepository,
} from "./connector-credentials.js";
import { LongPollConnectorJobRelay } from "./long-poll-job-relay.js";

const principal: ConnectorPrincipal = {
  authenticatedUserId: "10000000-0000-4000-8000-000000000001",
  connectorInstanceId: "connector_instance_0001",
};

class MemoryCredentials implements ConnectorCredentialRepository {
  readonly records = new Map<string, ConnectorPrincipal>();

  async create(input: Readonly<{
    authenticatedUserId: string;
    connectorInstanceId: string;
    tokenHashHex: string;
  }>): Promise<boolean> {
    for (const [hash, record] of this.records) {
      if (
        record.authenticatedUserId === input.authenticatedUserId &&
        record.connectorInstanceId === input.connectorInstanceId
      ) this.records.delete(hash);
    }
    this.records.set(input.tokenHashHex, {
      authenticatedUserId: input.authenticatedUserId,
      connectorInstanceId: input.connectorInstanceId,
    });
    return true;
  }

  async authenticate(tokenHashHex: string): Promise<ConnectorPrincipal | null> {
    return this.records.get(tokenHashHex) ?? null;
  }

  async revoke(input: Readonly<ConnectorPrincipal>): Promise<boolean> {
    let changed = false;
    for (const [hash, record] of this.records) {
      if (
        record.authenticatedUserId === input.authenticatedUserId &&
        record.connectorInstanceId === input.connectorInstanceId
      ) {
        this.records.delete(hash);
        changed = true;
      }
    }
    return changed;
  }
}

describe("connector credentials", () => {
  it("stores only a token hash and resolves the bound principal", async () => {
    const repository = new MemoryCredentials();
    const service = new ConnectorCredentialService(repository, 3_600);
    const issued = await service.issue(
      principal.authenticatedUserId,
      principal.connectorInstanceId,
    );
    expect(issued.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repository.records.has(issued.credential)).toBe(false);
    expect(repository.records.has(createHash("sha256").update(issued.credential).digest("hex")))
      .toBe(true);
    await expect(service.authenticate(issued.credential)).resolves.toEqual(principal);
  });

  it("rotates and revokes credentials per connector installation", async () => {
    const repository = new MemoryCredentials();
    const service = new ConnectorCredentialService(repository, 3_600);
    const first = await service.issue(
      principal.authenticatedUserId,
      principal.connectorInstanceId,
    );
    const second = await service.issue(
      principal.authenticatedUserId,
      principal.connectorInstanceId,
    );
    await expect(service.authenticate(first.credential)).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
    await expect(service.authenticate(second.credential)).resolves.toEqual(principal);
    await service.revoke(principal.authenticatedUserId, principal.connectorInstanceId);
    await expect(service.authenticate(second.credential)).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
  });

  it("issues via web identity but authenticates jobs only with the connector bearer", async () => {
    const repository = new MemoryCredentials();
    const credentials = new ConnectorCredentialService(repository, 3_600);
    const authenticatedUserId = vi.fn(async () => principal.authenticatedUserId);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "legacy-token" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        relay: new LongPollConnectorJobRelay(),
        credentials,
        authenticatedUserId,
        resolveConnectorPrincipal: createConnectorPrincipalResolver(credentials),
      },
    );
    const issue = await app.inject({
      method: "POST",
      url: "/api/connectors/credentials",
      payload: { connectorInstanceId: principal.connectorInstanceId },
    });
    expect(issue.statusCode).toBe(201);
    const credential = issue.json().connector.credential as string;
    expect(authenticatedUserId).toHaveBeenCalledOnce();

    const session = await app.inject({
      method: "GET",
      url: "/api/connectors/session",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ connector: principal });
    await app.close();
  });
});
