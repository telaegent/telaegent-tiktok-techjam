import { describe, expect, it } from "vitest";
import {
  MockRelayCancelledError,
  runMockAgentRelay,
  type MockRelayEndpoint,
  type MockRelayTurnRequest,
} from "./mock-agent-relay.js";

function endpoint(
  provider: MockRelayEndpoint["provider"],
  turns: Array<{ message: string; sessionId?: string }>,
) {
  const calls: MockRelayTurnRequest[] = [];
  const value: MockRelayEndpoint = {
    provider,
    async runTurn(request) {
      calls.push(request);
      const turn = turns.shift();
      if (!turn) throw new Error("Unexpected relay turn");
      return turn;
    },
  };
  return { calls, value };
}

describe("mock two-agent relay", () => {
  it("relays an approved Claude message to Codex and resumes Claude with the reply", async () => {
    const claude = endpoint("claude", [
      { message: "Please reply with hello.", sessionId: "claude-session" },
      { message: "I received hello." },
    ]);
    const codex = endpoint("codex", [
      { message: "hello", sessionId: "codex-session" },
    ]);
    const approvals: string[] = [];

    const transcript = await runMockAgentRelay({
      sender: claude.value,
      recipient: codex.value,
      instruction: "Tell Codex to say hello",
      approve: async ({ message }) => {
        approvals.push(message);
        return message;
      },
    });

    expect(approvals).toEqual(["Please reply with hello.", "hello"]);
    expect(codex.calls).toEqual([
      { stage: "recipient_reply", input: "Please reply with hello." },
    ]);
    expect(claude.calls[1]).toEqual({
      stage: "sender_receive",
      input: "hello",
      sessionId: "claude-session",
    });
    expect(transcript).toEqual({
      senderDraft: "Please reply with hello.",
      recipientReply: "hello",
      senderReceipt: "I received hello.",
      senderSessionId: "claude-session",
      recipientSessionId: "codex-session",
    });
  });

  it("does not call the recipient when the mock human rejects the request", async () => {
    const claude = endpoint("claude", [{ message: "Please reply with hello." }]);
    const codex = endpoint("codex", [{ message: "must not run" }]);

    await expect(
      runMockAgentRelay({
        sender: claude.value,
        recipient: codex.value,
        instruction: "Tell Codex to say hello",
        approve: async () => null,
      }),
    ).rejects.toBeInstanceOf(MockRelayCancelledError);
    expect(codex.calls).toEqual([]);
  });
});
