import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { ConnectorPrincipal } from "../repository-proof/contract.js";
import {
  ConnectorCredentialService,
  SupabaseConnectorCredentialRepository,
  createConnectorPrincipalResolver,
  type ConnectorSetupStatus,
  type ConnectorCredentialRepository,
} from "./connector-credentials.js";
import { LongPollConnectorJobRelay } from "./long-poll-job-relay.js";

const principal: ConnectorPrincipal = {
  authenticatedUserId: "10000000-0000-4000-8000-000000000001",
  connectorInstanceId: "connector_instance_0001",
};

class MemoryCredentials implements ConnectorCredentialRepository {
  readonly records = new Map<string, ConnectorPrincipal>();
  lastStatusInput: ConnectorPrincipal | null = null;
  bindings: ConnectorSetupStatus["bindings"] = [];

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

  async loadSetupStatus(
    input: Readonly<ConnectorPrincipal>,
  ): Promise<ConnectorSetupStatus> {
    this.lastStatusInput = input;
    const active = [...this.records.values()].some(
      (record) =>
        record.authenticatedUserId === input.authenticatedUserId &&
        record.connectorInstanceId === input.connectorInstanceId,
    );
    return {
      connectorInstanceId: input.connectorInstanceId,
      credential: active
        ? {
            status: "active",
            expiresAt: "2026-09-01T00:00:00.000Z",
            lastSeenAt: null,
          }
        : null,
      bindings: this.bindings,
      bindingsTruncated: false,
    };
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
    expect(issue.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(issue.headers.pragma).toBe("no-cache");
    const credential = issue.json().connector.credential as string;
    expect(authenticatedUserId).toHaveBeenCalledOnce();

    const session = await app.inject({
      method: "GET",
      url: "/api/connectors/session",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(session.statusCode).toBe(200);
    expect(session.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(session.headers.pragma).toBe("no-cache");
    expect(session.json()).toEqual({ connector: principal });

    const status = await app.inject({
      method: "GET",
      url: `/api/connectors/installations/${principal.connectorInstanceId}/status`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(status.headers.pragma).toBe("no-cache");
    expect(status.json()).toEqual({
      connector: {
        connectorInstanceId: principal.connectorInstanceId,
        credential: {
          status: "active",
          expiresAt: "2026-09-01T00:00:00.000Z",
          lastSeenAt: null,
        },
        bindings: [],
        bindingsTruncated: false,
        liveReady: false,
      },
    });
    expect(repository.lastStatusInput).toEqual(principal);
    expect(JSON.stringify(status.json())).not.toContain(credential);
    await app.close();
  });

  it("rejects malformed installation status identifiers before persistence", async () => {
    const repository = new MemoryCredentials();
    const credentials = new ConnectorCredentialService(repository, 3_600);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        relay: new LongPollConnectorJobRelay(),
        credentials,
        authenticatedUserId: async () => principal.authenticatedUserId,
        resolveConnectorPrincipal: createConnectorPrincipalResolver(credentials),
      },
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/connectors/installations/not-valid/status",
    });
    expect(response.statusCode).toBe(400);
    expect(repository.lastStatusInput).toBeNull();
    await app.close();
  });

  it("loads setup status through the owner-scoped backend RPC", async () => {
    const setupStatus: ConnectorSetupStatus = {
      connectorInstanceId: principal.connectorInstanceId,
      credential: {
        status: "active",
        expiresAt: "2026-09-01T00:00:00.000Z",
        lastSeenAt: "2026-08-31T23:59:45.000Z",
      },
      bindings: [{
        connectorBindingId: "50000000-0000-4000-8000-000000000005",
        projectId: "20000000-0000-4000-8000-000000000002",
        githubRepositoryId: "987654321",
        repositoryFullName: "telaegent/status-contract",
        visibility: "private",
        defaultBranch: "main",
        currentBranch: "feat/status",
        commitSha: "a".repeat(40),
        repositoryPermission: "write",
        repositoryAccessStatus: "verified",
        membershipStatus: "active",
        bindingStatus: "ready",
        verifiedAt: "2026-08-31T23:59:30.000Z",
        bindingLastSeenAt: "2026-08-31T23:59:30.000Z",
        unavailableReason: null,
      }],
      bindingsTruncated: false,
    };
    const fetchImplementation = vi.fn(async () => new Response(
      JSON.stringify(setupStatus),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const repository = new SupabaseConnectorCredentialRepository(
      "https://example.supabase.co",
      "backend-secret",
      1_000,
      fetchImplementation,
    );

    await expect(repository.loadSetupStatus(principal)).resolves.toEqual(setupStatus);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, request] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(
      "https://example.supabase.co/rest/v1/rpc/load_connector_setup_status",
    );
    expect(JSON.parse(String(request?.body))).toEqual({
      p_user_id: principal.authenticatedUserId,
      p_connector_instance_id: principal.connectorInstanceId,
      p_max_bindings: 25,
    });
    expect(request).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  });

  it("restores only a durable ready binding after a backend restart", async () => {
    const repository = new MemoryCredentials();
    const credentials = new ConnectorCredentialService(repository, 3_600);
    const issued = await credentials.issue(
      principal.authenticatedUserId,
      principal.connectorInstanceId,
    );
    const connectorBindingId = "50000000-0000-4000-8000-000000000005";
    repository.bindings = [{
      connectorBindingId,
      projectId: "20000000-0000-4000-8000-000000000002",
      githubRepositoryId: "987654321",
      repositoryFullName: "telaegent/restart-contract",
      visibility: "private",
      defaultBranch: "main",
      currentBranch: "main",
      commitSha: "a".repeat(40),
      repositoryPermission: "write",
      repositoryAccessStatus: "verified",
      membershipStatus: "active",
      bindingStatus: "ready",
      verifiedAt: "2026-08-31T23:59:30.000Z",
      bindingLastSeenAt: null,
      unavailableReason: null,
    }];
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
        authenticatedUserId: async () => principal.authenticatedUserId,
        resolveConnectorPrincipal: createConnectorPrincipalResolver(credentials),
      },
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/connectors/jobs/next?connectorBindingId=${connectorBindingId}&waitMs=0`,
      headers: { authorization: `Bearer ${issued.credential}` },
    });

    expect(response.statusCode).toBe(204);
    expect(relay.registeredRepository(principal, connectorBindingId)).toBe("987654321");
    expect(repository.lastStatusInput).toEqual(principal);
    await app.close();
  });

  it("does not restore revoked, suspended, stale, or unavailable bindings", async () => {
    const repository = new MemoryCredentials();
    const credentials = new ConnectorCredentialService(repository, 3_600);
    const connectorBindingId = "50000000-0000-4000-8000-000000000005";
    const ready: ConnectorSetupStatus["bindings"][number] = {
      connectorBindingId,
      projectId: "20000000-0000-4000-8000-000000000002",
      githubRepositoryId: "987654321",
      repositoryFullName: "telaegent/restart-contract",
      visibility: "private",
      defaultBranch: "main",
      currentBranch: null,
      commitSha: null,
      repositoryPermission: "read",
      repositoryAccessStatus: "verified",
      membershipStatus: "active",
      bindingStatus: "ready",
      verifiedAt: "2026-08-31T23:59:30.000Z",
      bindingLastSeenAt: null,
      unavailableReason: null,
    };

    for (const unsafe of [
      { ...ready, bindingStatus: "revoked" as const },
      { ...ready, membershipStatus: "suspended" as const },
      { ...ready, repositoryAccessStatus: "revalidation_required" as const },
      { ...ready, bindingStatus: "unavailable" as const, unavailableReason: "lost_access" },
    ]) {
      repository.bindings = [unsafe];
      await expect(
        credentials.restoreReadyBinding(principal, connectorBindingId),
      ).resolves.toBeNull();
    }
  });
});
