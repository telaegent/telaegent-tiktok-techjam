import { describe, expect, it, vi } from "vitest";
import {
  SupabaseCollaborationTaskRepository,
  type SupabaseCollaborationTaskClient,
} from "./collaboration-tasks.js";
import { SupabaseAuthorizationRpcClient } from "./supabase-authorization-client.js";

const taskId = "20000000-0000-4000-8000-000000000001";
const messageId = "80000000-0000-4000-8000-000000000001";
const responderId = "10000000-0000-4000-8000-000000000002";
const requesterId = "10000000-0000-4000-8000-000000000003";

function client(
  overrides: Partial<SupabaseCollaborationTaskClient>,
): SupabaseCollaborationTaskClient {
  return {
    openCollaborationTask: async () => ({ outcome: "unavailable" }),
    endCollaborationTask: async () => ({ outcome: "unavailable" }),
    ...overrides,
  };
}

describe("collaboration task repository", () => {
  it("reads back the bounded task a crossing message opened", async () => {
    const repository = new SupabaseCollaborationTaskRepository(
      client({
        openCollaborationTask: async () => ({
          outcome: "opened",
          taskId,
          conversationId: "30000000-0000-4000-8000-000000000001",
          githubRepositoryId: "1345851084",
          requesterUserId: requesterId,
          responderUserId: responderId,
          expiresAt: "2026-08-31T10:40:00.000Z",
        }),
      }),
    );

    await expect(
      repository.openTask({
        taskId,
        originSharedMessageId: messageId,
        responderUserId: responderId,
      }),
    ).resolves.toMatchObject({
      outcome: "opened",
      taskId,
      // Both peers come back from the record. The caller has to know which of
      // them owns the repository a follow-up would read, and deriving it here
      // means nobody has to assert it.
      requesterUserId: requesterId,
      responderUserId: responderId,
    });
  });

  it("reports a message it may not open a task for without saying why", async () => {
    const repository = new SupabaseCollaborationTaskRepository(
      client({ openCollaborationTask: async () => ({ outcome: "unavailable" }) }),
    );

    // A message that does not exist, a closed conversation and two people who
    // are not both in it are one answer, so none of the three can be probed.
    await expect(
      repository.openTask({
        taskId,
        originSharedMessageId: messageId,
        responderUserId: responderId,
      }),
    ).resolves.toEqual({ outcome: "unavailable" });
  });

  it("refuses a payload that is not one of the outcomes it knows", async () => {
    const repository = new SupabaseCollaborationTaskRepository(
      client({
        openCollaborationTask: async () => ({ outcome: "opened", taskId: "not-a-uuid" }),
      }),
    );

    await expect(
      repository.openTask({
        taskId,
        originSharedMessageId: messageId,
        responderUserId: responderId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_SUPABASE_CAPABILITY_SNAPSHOT" });
  });

  it("collapses a transport failure into one unavailability", async () => {
    const repository = new SupabaseCollaborationTaskRepository(
      client({
        endCollaborationTask: async () => {
          throw new Error("supabase said something detailed about its internals");
        },
      }),
    );

    await expect(
      repository.endTask({
        taskId,
        actorUserId: responderId,
        status: "completed",
      }),
    ).rejects.toMatchObject({ code: "SUPABASE_CAPABILITY_UNAVAILABLE" });
  });
});

describe("collaboration task RPC client", () => {
  it("sends only the message and the peer, and lets the database derive the rest", async () => {
    const fetch = vi.fn(async () =>
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

    await rpc.openCollaborationTask({
      taskId,
      originSharedMessageId: messageId,
      responderUserId: responderId,
    });

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    // Scope is never asserted by the caller: no conversation, project or
    // repository is sent, so this call cannot point a task somewhere the
    // message did not already belong.
    expect(JSON.parse(String(init.body))).toEqual({
      p_task_id: taskId,
      p_origin_shared_message_id: messageId,
      p_responder_user_id: responderId,
    });
  });

  it("refuses a closure that is not one of the two ways a task ends", async () => {
    const rpc = new SupabaseAuthorizationRpcClient({
      supabaseUrl: "https://example.supabase.co",
      secretKey: "sb_secret_" + "e".repeat(24),
    });

    await expect(
      rpc.endCollaborationTask({
        taskId,
        actorUserId: responderId,
        status: "deleted" as "completed",
      }),
    ).rejects.toThrow();
  });
});
