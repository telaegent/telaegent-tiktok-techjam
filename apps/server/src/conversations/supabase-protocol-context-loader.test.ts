import { describe, expect, it, vi } from "vitest";
import { SupabaseProtocolContextLoader } from "./supabase-protocol-context-loader.js";

const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  githubRepositoryId: "9223372036854775807",
  conversationId: "70000000-0000-4000-8000-000000000007",
  provider: "claude" as const,
};
const context = {
  role: "sender",
  facts: {
    repositoryFullName: "Telaegent/secret",
    githubRepositoryId: scope.githubRepositoryId,
    branch: "main",
    commit: "a".repeat(40),
    ownerName: "Phuong",
    collaboratorName: "Justin",
  },
  sharedHistory: [{
    id: "80000000-0000-4000-8000-000000000008",
    author: "Justin",
    origin: "agent",
    text: "Approved shared fact",
    at: "2026-08-31T03:00:00.000Z",
  }],
  projectFacts: ["Repository: Telaegent/secret"],
  privateTurns: [],
  ownerInput: "Draft a reply",
};
// The same durable scope, reconstructed for the other side of the round trip:
// the collaborator's text replaces the owner's input and nothing else moves.
const recipientContext = {
  role: "recipient",
  facts: context.facts,
  sharedHistory: context.sharedHistory,
  projectFacts: context.projectFacts,
  privateTurns: context.privateTurns,
  incomingMessage: "Does rounding happen before or after tax?",
};

describe("SupabaseProtocolContextLoader", () => {
  it("loads a sender draft by trusted scope and correlation ID", async () => {
    const fetchImplementation = vi.fn(async (input, init) => {
      expect(String(input)).toBe(
        "https://project.supabase.co/rest/v1/rpc/load_sender_protocol_context",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        p_user_id: scope.userId,
        p_github_repository_id: scope.githubRepositoryId,
        p_conversation_id: scope.conversationId,
        p_draft_id: "90000000-0000-4000-8000-000000000009",
        p_message_limit: 200,
      });
      return new Response(JSON.stringify(context), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const loader = new SupabaseProtocolContextLoader(
      "https://project.supabase.co",
      "sb_secret_12345678901234567890",
      fetchImplementation,
    );
    await expect(loader.load(scope, {
      purpose: "sender_draft",
      correlationId: "90000000-0000-4000-8000-000000000009",
    })).resolves.toEqual(context);
  });

  it("loads a recipient answer from its own durable function", async () => {
    const fetchImplementation = vi.fn(async (input, init) => {
      expect(String(input)).toBe(
        "https://project.supabase.co/rest/v1/rpc/load_recipient_protocol_context",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        p_user_id: scope.userId,
        p_github_repository_id: scope.githubRepositoryId,
        p_conversation_id: scope.conversationId,
        p_draft_id: "90000000-0000-4000-8000-000000000009",
        p_message_limit: 200,
      });
      return new Response(JSON.stringify(recipientContext), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const loader = new SupabaseProtocolContextLoader(
      "https://project.supabase.co",
      "sb_secret_12345678901234567890",
      fetchImplementation,
    );
    await expect(loader.load(scope, {
      purpose: "recipient_answer",
      correlationId: "90000000-0000-4000-8000-000000000009",
    })).resolves.toEqual(recipientContext);
  });

  it("fails closed for a purpose no durable function reconstructs", async () => {
    const fetchImplementation = vi.fn();
    const loader = new SupabaseProtocolContextLoader(
      "https://project.supabase.co",
      "sb_secret_12345678901234567890",
      fetchImplementation,
    );
    await expect(loader.load(scope, {
      purpose: "implement",
      correlationId: "90000000-0000-4000-8000-000000000009",
    })).resolves.toBeNull();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  // The envelope only protects the collaborator's text while it arrives in
  // exactly one field. A row carrying both would let the same string reach the
  // model once wrapped and once as the owner's own trusted instruction.
  it("rejects a row that carries both roles' input fields", async () => {
    const loader = new SupabaseProtocolContextLoader(
      "https://project.supabase.co",
      "sb_secret_12345678901234567890",
      async () => new Response(JSON.stringify({
        ...recipientContext,
        ownerInput: "Draft a reply",
      }), { status: 200 }),
    );
    await expect(loader.load(scope, {
      purpose: "recipient_answer",
      correlationId: "90000000-0000-4000-8000-000000000009",
    })).rejects.toThrow("Durable protocol context is invalid");
  });

  it("rejects malformed or cross-project context instead of coercing it", async () => {
    const loader = new SupabaseProtocolContextLoader(
      "https://project.supabase.co",
      "sb_secret_12345678901234567890",
      async () => new Response(JSON.stringify({
        ...context,
        facts: { ...context.facts, githubRepositoryId: "2" },
        localWorkspacePath: "C:\\private\\repo",
      }), { status: 200 }),
    );
    await expect(loader.load(scope, {
      purpose: "sender_draft",
      correlationId: "90000000-0000-4000-8000-000000000009",
    })).rejects.toThrow("Durable protocol context is invalid");
  });
});
