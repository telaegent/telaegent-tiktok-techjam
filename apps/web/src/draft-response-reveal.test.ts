import { describe, expect, it } from "vitest";
import type { PrivateDraftView } from "./api";
import { draftResponseReveal } from "./draft-response-reveal";

function draft(
  state: PrivateDraftView["state"],
  updatedAt: string,
  turns: PrivateDraftView["privateTurns"] = [],
): PrivateDraftView {
  return {
    draftId: "draft-1",
    conversationId: "conversation-1",
    githubRepositoryId: "123",
    provider: "codex",
    role: "sender",
    state,
    roughMessage: "Please check the session guard",
    privateMessage: null,
    sendCandidate: null,
    privateTurns: turns,
    turnId: null,
    riskFlags: [],
    guardFindings: [],
    failure: null,
    incomingMessageId: null,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt,
    sentMessageId: null,
  };
}

describe("draft response reveal", () => {
  it("reveals only content added when a live provider turn settles", () => {
    const previousTurns = [{ speaker: "owner" as const, text: "Focus on refresh." }];
    expect(
      draftResponseReveal(
        draft("agent_working", "2026-09-08T00:00:00.000Z", previousTurns),
        draft("ready", "2026-09-08T00:00:02.000Z", [
          ...previousTurns,
          { speaker: "agent", text: "I found the guard." },
        ]),
      ),
    ).toEqual({
      draftId: "draft-1",
      responseVersion: "2026-09-08T00:00:02.000Z",
      firstNewTurnIndex: 1,
    });
  });

  it("reveals a real state transition even when timestamps share a millisecond", () => {
    const timestamp = "2026-09-08T00:00:02.000Z";
    expect(
      draftResponseReveal(
        draft("agent_working", timestamp),
        draft("ready", timestamp),
      ),
    ).toMatchObject({
      draftId: "draft-1",
      responseVersion: timestamp,
    });
  });

  it("does not replay recovered or unchanged responses", () => {
    const ready = draft("ready", "2026-09-08T00:00:02.000Z");
    expect(draftResponseReveal(null, ready)).toBeNull();
    expect(draftResponseReveal(ready, ready)).toBeNull();
  });

  it("does not animate runtime errors", () => {
    expect(
      draftResponseReveal(
        draft("agent_working", "2026-09-08T00:00:00.000Z"),
        draft("runtime_failed", "2026-09-08T00:00:02.000Z"),
      ),
    ).toBeNull();
  });
});
