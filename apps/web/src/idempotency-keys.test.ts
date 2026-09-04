import { describe, expect, it, vi } from "vitest";
import { getOrCreateIdempotencyKey } from "./idempotency-keys";

describe("stable idempotency keys", () => {
  it("reuses one key while the same operation is retried", () => {
    const keys = new Map<string, string>();
    const createId = vi.fn(() => "request-one");

    expect(getOrCreateIdempotencyKey(keys, "draft-1", "send", createId)).toBe(
      "send:draft-1:request-one",
    );
    expect(getOrCreateIdempotencyKey(keys, "draft-1", "send", createId)).toBe(
      "send:draft-1:request-one",
    );
    expect(createId).toHaveBeenCalledOnce();
  });

  it("creates a different key for a different draft", () => {
    const keys = new Map<string, string>();
    let sequence = 0;
    const createId = () => `request-${++sequence}`;

    expect(getOrCreateIdempotencyKey(keys, "draft-1", "send", createId)).not.toBe(
      getOrCreateIdempotencyKey(keys, "draft-2", "send", createId),
    );
  });
});
