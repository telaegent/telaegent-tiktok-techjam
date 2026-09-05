import { describe, expect, it, vi } from "vitest";
import {
  SupabaseOwnedCapabilityGrantRepository,
  type SupabaseOwnedCapabilityGrantClient,
} from "./capability-grant-management.js";

const ownerUserId = "10000000-0000-4000-8000-000000000001";
const grant = {
  grantId: "20000000-0000-4000-8000-000000000001",
  taskId: "30000000-0000-4000-8000-000000000001",
  conversationId: "40000000-0000-4000-8000-000000000001",
  githubRepositoryId: "1345851084",
  peerUserId: "10000000-0000-4000-8000-000000000002",
  resourceId: `resource_${"a".repeat(24)}`,
  resourceDisplayLabel: "src/settings.ts",
  operation: "read",
  mode: "task",
  grantedAt: "2026-09-05T01:00:00.000Z",
  expiresAt: "2026-09-05T02:00:00.000Z",
} as const;

function client(
  overrides: Partial<SupabaseOwnedCapabilityGrantClient> = {},
): SupabaseOwnedCapabilityGrantClient {
  return {
    listOwnedCapabilityGrants: async () => [grant],
    revokeOwnedCapabilityGrant: async () => ({
      outcome: "revoked",
      grantId: grant.grantId,
      resourceId: grant.resourceId,
      expiresAt: grant.expiresAt,
    }),
    ...overrides,
  };
}

describe("SupabaseOwnedCapabilityGrantRepository", () => {
  it("maps only the bounded owner-safe grant projection", async () => {
    const listOwnedCapabilityGrants = vi.fn(async () => [grant]);
    const repository = new SupabaseOwnedCapabilityGrantRepository(
      client({ listOwnedCapabilityGrants }),
    );

    await expect(
      repository.listOwnedGrants({
        ownerUserId,
        githubRepositoryId: "1345851084",
      }),
    ).resolves.toEqual([grant]);
    expect(listOwnedCapabilityGrants).toHaveBeenCalledWith(
      { ownerUserId, githubRepositoryId: "1345851084" },
      undefined,
    );
  });

  it("rejects canonical paths and expanded authority in an RPC response", async () => {
    for (const unsafe of [
      { ...grant, canonicalPath: "D:/private/repo/src/settings.ts" },
      { ...grant, operation: "write" },
    ]) {
      const repository = new SupabaseOwnedCapabilityGrantRepository(
        client({ listOwnedCapabilityGrants: async () => [unsafe] }),
      );
      await expect(
        repository.listOwnedGrants({
          ownerUserId,
          githubRepositoryId: "1345851084",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_SUPABASE_CAPABILITY_SNAPSHOT",
      });
    }
  });

  it("forwards owner-scoped revocation and its opaque result", async () => {
    const revokeOwnedCapabilityGrant = vi.fn(async () => ({ outcome: "unavailable" }));
    const repository = new SupabaseOwnedCapabilityGrantRepository(
      client({ revokeOwnedCapabilityGrant }),
    );

    await expect(
      repository.revokeOwnedGrant({ ownerUserId, grantId: grant.grantId }),
    ).resolves.toEqual({ outcome: "unavailable" });
    expect(revokeOwnedCapabilityGrant).toHaveBeenCalledWith(
      { ownerUserId, grantId: grant.grantId },
      undefined,
    );
  });
});
