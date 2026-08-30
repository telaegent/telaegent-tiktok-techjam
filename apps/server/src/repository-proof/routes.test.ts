import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { RepositoryProofService } from "./service.js";

const principal = {
  authenticatedUserId: "10000000-0000-4000-8000-000000000001",
  connectorInstanceId: "connector_instance_0001",
};
const proof = {
  version: 1,
  proofId: "20000000-0000-4000-8000-000000000002",
  observedAt: "2026-08-31T01:59:30.000Z",
  github: { userId: "123456789", login: "khoa-dao" },
  repository: {
    id: "9223372036854775807",
    owner: "Telaegent",
    name: "codejam.repo",
    visibility: "private",
    defaultBranch: "main",
    currentBranch: "khoa.dao",
    commitSha: "a".repeat(40),
    permission: "write",
  },
};

describe("repository proof HTTP boundary", () => {
  it("uses connector authentication rather than browser/legacy identity", async () => {
    const register = vi.fn(async () => ({
      proofId: proof.proofId,
      githubConnectionId: "30000000-0000-4000-8000-000000000003",
      projectId: "40000000-0000-4000-8000-000000000004",
      githubRepositoryId: proof.repository.id,
      connectorBindingId: "50000000-0000-4000-8000-000000000005",
      accessStatus: "verified" as const,
      membershipStatus: "active" as const,
      bindingStatus: "ready" as const,
      verifiedAt: proof.observedAt,
      replayed: false,
    }));
    const markUnavailable = vi.fn(async () => ({
      githubRepositoryId: proof.repository.id,
      accessStatus: "revalidation_required" as const,
      membershipStatus: "suspended" as const,
      bindingStatus: "unavailable" as const,
      changed: true,
    }));
    const resolveConnectorPrincipal = vi.fn(async () => principal);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "legacy-token" }),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        service: { register, markUnavailable } as unknown as RepositoryProofService,
        resolveConnectorPrincipal,
      },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connectors/repository-proofs",
      payload: proof,
    });
    expect(response.statusCode).toBe(201);
    expect(resolveConnectorPrincipal).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith(principal, proof);
    expect(response.json().binding.connectorBindingId).toBe(
      "50000000-0000-4000-8000-000000000005",
    );

    const unavailable = await app.inject({
      method: "POST",
      url:
        "/api/connectors/repositories/" +
        proof.repository.id +
        "/unavailable",
      payload: {
        observedAt: proof.observedAt,
        reason: "repository_access_lost",
      },
    });
    expect(unavailable.statusCode).toBe(200);
    expect(markUnavailable).toHaveBeenCalledWith(
      principal,
      proof.repository.id,
      {
        observedAt: proof.observedAt,
        reason: "repository_access_lost",
      },
    );
    await app.close();
  });

  it("does not mount or exempt the route until connector auth is supplied", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "legacy-token" }),
      undefined,
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/connectors/repository-proofs",
      payload: proof,
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
