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

const listInput = {
  taskId: "20000000-0000-4000-8000-000000000001",
  ownerUserId: input.ownerUserId,
  peerUserId: input.peerUserId,
} as const;

function client(
  consumeCapabilityGrant: SupabaseCapabilityGrantClient["consumeCapabilityGrant"],
  listTaskCapabilityGrants: SupabaseCapabilityGrantClient["listTaskCapabilityGrants"] = async () => ({
    outcome: "unavailable",
  }),
): SupabaseCapabilityGrantClient {
  return { consumeCapabilityGrant, listTaskCapabilityGrants };
}

function listing(
  listTaskCapabilityGrants: SupabaseCapabilityGrantClient["listTaskCapabilityGrants"],
): SupabaseCapabilityGrantRepository {
  return new SupabaseCapabilityGrantRepository(
    client(async () => ({ outcome: "unavailable" }), listTaskCapabilityGrants),
  );
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

describe("reading back what a human already approved", () => {
  it("returns the identifiers a peer may still assert", async () => {
    const repository = listing(async () => ({
      outcome: "listed",
      grants: [{ grantId: input.grantId, resourceId: input.resourceId }],
    }));

    await expect(repository.listTaskGrants(listInput)).resolves.toEqual({
      outcome: "listed",
      grants: [{ grantId: input.grantId, resourceId: input.resourceId }],
    });
  });

  it("gives one answer for every task it will not list", async () => {
    const repository = listing(async () => ({ outcome: "unavailable" }));

    // A task that never existed, one belonging to other people and one already
    // closed are the same answer, so none can be probed for.
    await expect(repository.listTaskGrants(listInput)).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  it("refuses a ledger carrying anything but opaque identifiers", async () => {
    const repository = listing(async () => ({
      outcome: "listed",
      // A path is not a resource identifier. If one ever appeared here the
      // cloud would be holding a fact about somebody's repository layout.
      grants: [{ grantId: input.grantId, resourceId: "src/settings.ts" }],
    }));

    await expect(repository.listTaskGrants(listInput)).rejects.toMatchObject({
      code: "INVALID_SUPABASE_CAPABILITY_SNAPSHOT",
    });
  });

  it("collapses a transport failure into one unavailability", async () => {
    const repository = listing(async () => {
      throw new Error("supabase said something detailed about its internals");
    });

    await expect(repository.listTaskGrants(listInput)).rejects.toMatchObject({
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

  it("names the task and both peers when reading the ledger, and nothing else", async () => {
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

    await rpc.listTaskCapabilityGrants(listInput);

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    // No resource is named. A caller cannot ask whether one particular file is
    // approved; it may only read back the whole bounded ledger it already owns.
    expect(JSON.parse(String(init.body))).toEqual({
      p_task_id: listInput.taskId,
      p_owner_user_id: listInput.ownerUserId,
      p_peer_user_id: listInput.peerUserId,
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
