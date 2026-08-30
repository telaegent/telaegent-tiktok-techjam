import { describe, expect, it, vi } from "vitest";
import { RuntimeProgressChannel } from "./runtime-progress-channel.js";

const owner = {
  userId: "user-a",
  repositoryId: "repo-123",
  conversationId: "conversation-1",
};

describe("RuntimeProgressChannel", () => {
  it("streams and replays safe progress in order", () => {
    const channel = new RuntimeProgressChannel(
      10,
      () => new Date("2026-08-30T00:00:00.000Z"),
    );
    const streamId = channel.open(owner);
    channel.publish(streamId, { type: "session_started", provider: "codex" });
    const listener = vi.fn();
    const subscription = channel.subscribe(streamId, owner, listener);

    channel.publish(streamId, {
      type: "text_delta",
      provider: "codex",
      text: "Hello",
    });

    expect(subscription?.replay).toEqual([
      {
        sequence: 1,
        occurredAt: "2026-08-30T00:00:00.000Z",
        progress: { type: "session_started", provider: "codex" },
      },
    ]);
    expect(listener).toHaveBeenCalledWith({
      sequence: 2,
      occurredAt: "2026-08-30T00:00:00.000Z",
      progress: { type: "text_delta", provider: "codex", text: "Hello" },
    });
  });

  it("requires the authenticated owner scope, not only the stream ID", () => {
    const channel = new RuntimeProgressChannel();
    const streamId = channel.open(owner);

    expect(
      channel.subscribe(streamId, { ...owner, userId: "user-b" }, vi.fn()),
    ).toBeNull();
    expect(
      channel.subscribe(streamId, { ...owner, repositoryId: "repo-456" }, vi.fn()),
    ).toBeNull();
    expect(
      channel.subscribe(
        streamId,
        { ...owner, conversationId: "conversation-2" },
        vi.fn(),
      ),
    ).toBeNull();
  });

  it("bounds replay and isolates broken subscribers from the runtime", () => {
    const channel = new RuntimeProgressChannel(2);
    const streamId = channel.open(owner);
    channel.subscribe(streamId, owner, () => {
      throw new Error("browser disconnected");
    });

    expect(
      channel.publish(streamId, { type: "turn_started", provider: "claude" }),
    ).toBe(true);
    channel.publish(streamId, {
      type: "text_delta",
      provider: "claude",
      text: "one",
    });
    channel.publish(streamId, { type: "turn_completed", provider: "claude" });
    const subscription = channel.subscribe(streamId, owner, vi.fn());

    expect(subscription?.replay.map((event) => event.sequence)).toEqual([2, 3]);
  });

  it("only lets the owner close a stream", () => {
    const channel = new RuntimeProgressChannel();
    const streamId = channel.open(owner);

    expect(channel.close(streamId, { ...owner, userId: "user-b" })).toBe(false);
    expect(channel.publish(streamId, { type: "turn_started", provider: "codex" })).toBe(true);
    expect(channel.close(streamId, owner)).toBe(true);
    expect(channel.publish(streamId, { type: "turn_completed", provider: "codex" })).toBe(false);
  });
});
