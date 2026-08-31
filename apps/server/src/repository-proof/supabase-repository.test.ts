import { describe, expect, it, vi } from "vitest";
import { SupabaseRepositoryProofRepository } from "./supabase-repository.js";

const secretKey = "sb_secret_" + "s".repeat(32);
const principal = {
  authenticatedUserId: "10000000-0000-4000-8000-000000000001",
  connectorInstanceId: "connector_instance_0001",
};
const proof = {
  version: 1 as const,
  proofId: "20000000-0000-4000-8000-000000000002",
  observedAt: "2026-08-31T01:59:30.000Z",
  github: { userId: "123456789", login: "khoa-dao" },
  repository: {
    id: "9223372036854775807",
    owner: "Telaegent",
    name: "codejam.repo",
    visibility: "private" as const,
    defaultBranch: "main",
    currentBranch: "khoa.dao",
    commitSha: "a".repeat(40),
    permission: "write" as const,
  },
};
const result = {
  proofId: proof.proofId,
  githubConnectionId: "30000000-0000-4000-8000-000000000003",
  projectId: "40000000-0000-4000-8000-000000000004",
  githubRepositoryId: proof.repository.id,
  connectorBindingId: "50000000-0000-4000-8000-000000000005",
  accessStatus: "verified",
  membershipStatus: "active",
  bindingStatus: "ready",
  verifiedAt: proof.observedAt,
  replayed: false,
};

function repository(fetchImplementation: typeof fetch) {
  return new SupabaseRepositoryProofRepository(
    "https://project.supabase.co/",
    secretKey,
    5_000,
    fetchImplementation,
  );
}

describe("SupabaseRepositoryProofRepository", () => {
  it("calls the backend-only registration RPC with precision-safe safe metadata", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(result));
    await expect(
      repository(request).registerRepositoryProof({
        principal,
        proof,
        repositoryFullName: "Telaegent/codejam.repo",
        payloadDigestHex: "d".repeat(64),
      }),
    ).resolves.toEqual(result);

    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(
      "https://project.supabase.co/rest/v1/rpc/register_local_github_repository_proof",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("apikey")).toBe(secretKey);
    expect(headers.get("authorization")).toBeNull();
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      p_user_id: principal.authenticatedUserId,
      p_connector_instance_id: principal.connectorInstanceId,
      p_github_repository_id: "9223372036854775807",
      p_current_branch: "khoa.dao",
      p_commit_sha: "a".repeat(40),
    });
    expect(JSON.stringify(body)).not.toMatch(/workspace|remote|token|rawOutput/i);
  });

  it("maps database policy denials without exposing details", async () => {
    for (const [error, code, statusCode] of [
      ["github_identity_mismatch", "REPOSITORY_PROOF_FORBIDDEN", 403],
      ["membership_revoked", "REPOSITORY_PROOF_FORBIDDEN", 403],
      ["binding_not_owned", "REPOSITORY_PROOF_FORBIDDEN", 403],
      ["proof_id_conflict", "REPOSITORY_PROOF_CONFLICT", 409],
      ["stale_observation", "REPOSITORY_PROOF_CONFLICT", 409],
    ] as const) {
      const request = vi.fn<typeof fetch>(async () => Response.json({ error }));
      await expect(
        repository(request).registerRepositoryProof({
          principal,
          proof,
          repositoryFullName: "Telaegent/codejam.repo",
          payloadDigestHex: "d".repeat(64),
        }),
      ).rejects.toMatchObject({ code, statusCode });
    }
  });

  it("fails closed on HTTP errors, oversized bodies, and malformed success JSON", async () => {
    const cases: Array<typeof fetch> = [
      vi.fn(async () => new Response("sensitive SQL", { status: 500 })),
      vi.fn(async () =>
        new Response("{}", { headers: { "content-length": "16385" } }),
      ),
      vi.fn(async () => Response.json({ bindingStatus: "ready" })),
    ];
    for (const request of cases) {
      await expect(
        repository(request).registerRepositoryProof({
          principal,
          proof,
          repositoryFullName: "Telaegent/codejam.repo",
          payloadDigestHex: "d".repeat(64),
        }),
      ).rejects.toMatchObject({
        code: "REPOSITORY_PROOF_UNAVAILABLE",
        message: "Repository proof service is temporarily unavailable",
      });
    }
  });

  it("rejects publishable keys and unsafe Supabase URLs", () => {
    expect(
      () =>
        new SupabaseRepositoryProofRepository(
          "http://project.supabase.co",
          secretKey,
          5_000,
        ),
    ).toThrow("Repository proof persistence configuration is invalid");
    expect(
      () =>
        new SupabaseRepositoryProofRepository(
          "https://project.supabase.co",
          "sb_publishable_public",
          5_000,
        ),
    ).toThrow("Repository proof persistence configuration is invalid");
  });
});
