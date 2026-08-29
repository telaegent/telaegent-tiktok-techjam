import { describe, expect, it } from "vitest";
import { TELAGENT_ENVELOPE_FIXTURES } from "./contract-fixtures.js";
import {
  assertReplyInheritance,
  assertRequestTiming,
  createIdempotencyRecord,
  evaluateIdempotency,
  fingerprintRequest,
  RequestRuleError,
} from "./request-rules.js";
import { telagentEnvelopeSchema } from "./schemas.js";
import type { TelagentRequest } from "./types.js";

const publish = (): TelagentRequest =>
  structuredClone(TELAGENT_ENVELOPE_FIXTURES.relay_publish_intent);

describe("request timing rules", () => {
  it("accepts a fresh bounded request", () => {
    expect(() => assertRequestTiming(publish(), "2026-08-28T02:05:00.000Z")).not.toThrow();
  });

  it("distinguishes expired, future-skewed, and excessive-TTL requests", () => {
    expect(() => assertRequestTiming(publish(), "2026-08-28T02:16:00.000Z")).toThrowError(
      RequestRuleError,
    );
    try {
      assertRequestTiming(publish(), "2026-08-28T02:16:00.000Z");
    } catch (error) {
      expect(error).toMatchObject({ code: "EXPIRED" });
    }
    const future = publish();
    future.delivery.createdAt = "2026-08-28T02:06:00.000Z";
    future.delivery.expiresAt = "2026-08-28T02:10:00.000Z";
    expect(() => assertRequestTiming(future, "2026-08-28T02:05:00.000Z")).toThrow(
      /future/,
    );
    const long = publish();
    long.delivery.expiresAt = "2026-08-28T03:00:00.000Z";
    expect(() => assertRequestTiming(long, "2026-08-28T02:05:00.000Z")).toThrow(
      /TTL/,
    );
  });
});

describe("idempotency rules", () => {
  it("replays the original operation for the same scope and fingerprint", () => {
    const request = publish();
    const record = createIdempotencyRecord(request, "op_01", "2026-08-28T02:01:00.000Z");
    expect(
      evaluateIdempotency([record], request, "2026-08-28T02:05:00.000Z"),
    ).toEqual({ kind: "replay", operationId: "op_01", requestId: request.requestId });
  });

  it("ignores request and correlation IDs but detects an execution payload change", () => {
    const request = publish();
    const replay = { ...request, requestId: "req_retry", correlationId: "corr_retry" };
    expect(fingerprintRequest(replay)).toBe(fingerprintRequest(request));
    const changed = structuredClone(request);
    if (changed.operation !== "relay_publish_intent") throw new Error("fixture mismatch");
    changed.payload.task = "A different task";
    const record = createIdempotencyRecord(request, "op_01", "2026-08-28T02:01:00.000Z");
    expect(
      evaluateIdempotency([record], changed, "2026-08-28T02:05:00.000Z"),
    ).toMatchObject({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("creates a new record after retention expiry or in a different scope", () => {
    const request = publish();
    const record = createIdempotencyRecord(request, "op_01", "2026-08-28T02:01:00.000Z");
    expect(evaluateIdempotency([record], request, "2026-08-28T03:00:00.000Z").kind).toBe(
      "create",
    );
    const otherSender = structuredClone(request);
    otherSender.sender = { ownerId: "bob", agentId: "bob-agent", provider: "codex" };
    expect(
      evaluateIdempotency([record], otherSender, "2026-08-28T02:05:00.000Z").kind,
    ).toBe("create");
  });
});

describe("reply inheritance", () => {
  const original = () =>
    telagentEnvelopeSchema.parse({
      ...TELAGENT_ENVELOPE_FIXTURES.relay_ask_status,
      requestId: "req_status_01",
      delivery: {
        ...TELAGENT_ENVELOPE_FIXTURES.relay_ask_status.delivery,
        exchangeNumber: 1,
      },
    });
  const reply = () =>
    telagentEnvelopeSchema.parse({
      ...TELAGENT_ENVELOPE_FIXTURES.relay_reply,
      sender: { ownerId: "bob", agentId: "bob-agent", provider: "codex" },
      recipient: { ownerId: "alice", agentId: "alice-agent" },
      delivery: {
        ...TELAGENT_ENVELOPE_FIXTURES.relay_reply.delivery,
        exchangeNumber: 2,
        replyToRequestId: "req_status_01",
      },
    });

  it("accepts only a reversed-identity, same-scope, next-exchange reply", () => {
    expect(() => assertReplyInheritance(reply(), original())).not.toThrow();
    const wrong = reply();
    wrong.conversationId = "other_conversation";
    expect(() => assertReplyInheritance(wrong, original())).toThrow(/does not inherit/);
  });

  it("rejects replies after the third exchange", () => {
    const atLimit = original();
    atLimit.delivery.exchangeNumber = 3;
    expect(() => assertReplyInheritance(reply(), atLimit)).toThrow(/exchange limit/);
  });
});
