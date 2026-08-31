import { describe, expect, it, vi } from "vitest";
import {
  SupabaseCapabilityGrantRepository,
  type SupabaseCapabilityGrantClient,
} from "./capability-grants.js";
import { SupabaseAuthorizationRpcClient } from "./supabase-authorization-client.js";

const input = {
  grantId: "40000000-0000-4000-8000-000000000001",
  ownerUserId: "10000000-0000-4000-8000-000000000001",
  peerUserId: "10000000-0000-4000-8000-000000000002",
  resourceId: "resource_0123456789abcdef0123",
} as const;

function client(
  consumeCapabilityGrant: SupabaseCapabilityGrantClient["consumeCapabilityGrant"],
): SupabaseCapabilityGrantClient {
  return { consumeCapabilityGrant };
}

describe("capability grant redemption", () => {
  it("spends an allow-once grant exactly once", async () => {
    const repository = new SupabaseCapabilityGrantRepository(
      client(async () => ({ outcome: "consumed", mode: "once" })),
    );

    await expect(repository.consumeGrant(input)).resolves.toEqual({
      outcome: "consumed",
      mode: "once",
    });
  });

  it("leaves an allow-for-this-task grant standing", async () => {
    const repository = new SupabaseCapabilityGrantRepository(
      client(async () => ({ outcome: "reusable", mode: "task" })),
    );

    await expect(repository.consumeGrant(input)).resolves.toEqual({
      outcome: "reusable",
      mode: "task",
    });
  });

  it("gives one answer for every way a grant fails to apply", async () => {
    const repository = new SupabaseCapabilityGrantRepository(
      client(async () => ({ outcome: "unavailable" })),
    );

    // A grant that never existed, one belonging to another pair of people and
    // one already spent are the same answer, so none can be probed for.
    await expect(repository.consumeGrant(input)).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  it("refuses an outcome it does not recognise", async () => {
    const repository = new SupabaseCapabilityGrantRepository(
      client(async () => ({ outcome: "consumed", mode: "task" })),
    );

    await expect(repository.consumeGrant(input)).rejects.toMatchObject({
      code: "INVALID_SUPABASE_CAPABILITY_SNAPSHOT",
    });
  });

  it("collapses a transport failure into one unavailability", async () => {
    const repository = new SupabaseCapabilityGrantRepository(
      client(async () => {
        throw new Error("supabase said something detailed about its internals");
      }),
    );

    await expect(repository.consumeGrant(input)).rejects.toMatchObject({
      code: "SUPABASE_CAPABILITY_UNAVAILABLE",
    });
  });
});

describe("capability grant RPC client", () => {
  it("names the grant, both peers and the resource, and nothing else", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ outcome: "unavailable" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const rpc = new SupabaseAuthorizationRpcClient({
      supabaseUrl: "https://example.supabase.co",
      secretKey: "sb_secret_" + "e".repeat(24),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await rpc.consumeCapabilityGrant(input);

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      p_grant_id: input.grantId,
      p_owner_user_id: input.ownerUserId,
      p_peer_user_id: input.peerUserId,
      p_resource_id: input.resourceId,
    });
  });

  it("refuses to redeem a grant a peer holds against themselves", async () => {
    const fetch = vi.fn();
    const rpc = new SupabaseAuthorizationRpcClient({
      supabaseUrl: "https://example.supabase.co",
      secretKey: "sb_secret_" + "e".repeat(24),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(
      rpc.consumeCapabilityGrant({ ...input, peerUserId: input.ownerUserId }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
