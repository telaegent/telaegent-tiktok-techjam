import { describe, expect, it } from "vitest";
import { TELAGENT_ERROR_HTTP_STATUS } from "./constants.js";
import { protocolError } from "./errors.js";
import { telagentErrorEnvelopeSchema } from "./schemas.js";

describe("Telagent protocol errors", () => {
  it("freezes every code to its required HTTP status", () => {
    expect(TELAGENT_ERROR_HTTP_STATUS).toEqual({
      INVALID_REQUEST: 400,
      POLICY_DENIED: 403,
      NOT_FOUND: 404,
      INVALID_STATE: 409,
      AGENT_BUSY: 409,
      EXPIRED: 410,
      STALE_VERSION: 412,
      INVALID_AGENT_OUTPUT: 422,
      OWNERSHIP_VIOLATION: 422,
      EXCHANGE_LIMIT: 429,
      RUNTIME_UNAVAILABLE: 503,
    });
  });

  it("serializes only safe error fields", () => {
    const error = protocolError(
      "POLICY_DENIED",
      "The requested path is always forbidden.",
      {
        correlationId: "corr_01",
        auditEventId: "evt_42",
        safeDetails: { rule: "FORBID_ENV_FILES" },
      },
    );
    expect(error.statusCode).toBe(403);
    const envelope = error.toEnvelope();
    expect(telagentErrorEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope).toEqual({
      error: {
        code: "POLICY_DENIED",
        message: "The requested path is always forbidden.",
        safeDetails: { rule: "FORBID_ENV_FILES" },
        correlationId: "corr_01",
        auditEventId: "evt_42",
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("stack");
    expect(JSON.stringify(envelope)).not.toContain("cause");
  });
});
