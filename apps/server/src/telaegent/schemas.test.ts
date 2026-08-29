import { describe, expect, it } from "vitest";
import {
  agreementDecisionHttpInputSchema,
  contextRequestHttpInputSchema,
  contextRequestDecisionInputSchema,
  contextRequestDecisionHttpInputSchema,
  isSafeRelativePath,
  normalizeProtocolPath,
  planIntentOutputSchema,
  projectSnapshotSchema,
  telaegentHttpBodySchemas,
  telaegentEnvelopeSchema,
} from "./schemas.js";

const validEnvelope = () => ({
  schemaVersion: "telaegent.v1",
  requestId: "req_01",
  correlationId: "corr_01",
  idempotencyKey: "intent_alice_v1",
  projectId: "phoenix",
  conversationId: "conv_phoenix",
  intentId: "intent_alice_oauth",
  sender: { ownerId: "alice", agentId: "alice-agent", provider: "codex" },
  operation: "relay_publish_intent",
  payload: {
    task: "Add Google OAuth",
    branch: "feature/google-oauth",
    baseCommit: "7dedb3a",
    plannedFiles: ["src/auth/oauth.ts", "src/routes/oauth-callback.ts"],
    interfaces: ["Session", "GET /oauth/callback"],
    dependencies: ["Session"],
    plan: ["Add the provider adapter", "Implement the callback route"],
  },
  delivery: {
    mode: "async",
    exchangeNumber: 1,
    createdAt: "2026-08-28T02:00:00.000Z",
    expiresAt: "2026-08-28T02:15:00.000Z",
  },
  evidence: { branch: "feature/google-oauth", baseCommit: "7dedb3a" },
});

describe("Telaegent envelope schema", () => {
  it("accepts a valid operation-specific envelope", () => {
    expect(telaegentEnvelopeSchema.parse(validEnvelope()).operation).toBe(
      "relay_publish_intent",
    );
  });

  it("rejects unknown versions and operation/payload mismatches", () => {
    expect(
      telaegentEnvelopeSchema.safeParse({ ...validEnvelope(), schemaVersion: "telaegent.v2" })
        .success,
    ).toBe(false);
    const mismatch = validEnvelope();
    mismatch.operation = "relay_update_progress";
    expect(telaegentEnvelopeSchema.safeParse(mismatch).success).toBe(false);
  });

  it("rejects permission injection at envelope and payload boundaries", () => {
    expect(
      telaegentEnvelopeSchema.safeParse({
        ...validEnvelope(),
        permissionClass: "AUTO_METADATA",
      }).success,
    ).toBe(false);
    expect(
      telaegentEnvelopeSchema.safeParse({
        ...validEnvelope(),
        payload: { ...validEnvelope().payload, permissionClass: "AUTO_METADATA" },
      }).success,
    ).toBe(false);
  });

  it("enforces expiry ordering and the exchange bound", () => {
    expect(
      telaegentEnvelopeSchema.safeParse({
        ...validEnvelope(),
        delivery: {
          ...validEnvelope().delivery,
          expiresAt: validEnvelope().delivery.createdAt,
        },
      }).success,
    ).toBe(false);
    for (const exchangeNumber of [0, 4]) {
      expect(
        telaegentEnvelopeSchema.safeParse({
          ...validEnvelope(),
          delivery: { ...validEnvelope().delivery, exchangeNumber },
        }).success,
      ).toBe(false);
    }
  });

  it("requires a distinct recipient for cross-Agent operations", () => {
    const request = {
      ...validEnvelope(),
      operation: "relay_ask_status",
      payload: { targetIntentId: "intent_bob_redis", purpose: "Check Session work" },
    };
    expect(telaegentEnvelopeSchema.safeParse(request).success).toBe(false);
    expect(
      telaegentEnvelopeSchema.safeParse({
        ...request,
        recipient: { ownerId: "alice", agentId: "alice-agent" },
      }).success,
    ).toBe(false);
    expect(
      telaegentEnvelopeSchema.safeParse({
        ...request,
        recipient: { ownerId: "bob", agentId: "bob-agent" },
      }).success,
    ).toBe(true);
  });

  it("requires matching reply identifiers", () => {
    const reply = {
      ...validEnvelope(),
      operation: "relay_reply",
      recipient: { ownerId: "bob", agentId: "bob-agent" },
      payload: {
        replyToRequestId: "req_status_01",
        responseKind: "acknowledgement",
        body: { acknowledged: true, summary: "Received" },
      },
      delivery: {
        ...validEnvelope().delivery,
        replyToRequestId: "req_other",
      },
    };
    expect(telaegentEnvelopeSchema.safeParse(reply).success).toBe(false);
    reply.delivery.replyToRequestId = "req_status_01";
    expect(telaegentEnvelopeSchema.safeParse(reply).success).toBe(true);
  });

  it("enforces bounded strings and arrays", () => {
    expect(
      telaegentEnvelopeSchema.safeParse({
        ...validEnvelope(),
        payload: {
          ...validEnvelope().payload,
          plannedFiles: Array.from({ length: 21 }, (_, index) => `src/file-${index}.ts`),
        },
      }).success,
    ).toBe(false);
    expect(
      telaegentEnvelopeSchema.safeParse({
        ...validEnvelope(),
        payload: { ...validEnvelope().payload, task: "x".repeat(2_001) },
      }).success,
    ).toBe(false);
  });
});

describe("path grammar", () => {
  it("normalizes Windows separators and a leading dot segment", () => {
    expect(normalizeProtocolPath(".\\src\\auth\\session.ts")).toBe(
      "src/auth/session.ts",
    );
  });

  it("accepts exact files and directory rules but rejects unsafe syntax", () => {
    expect(isSafeRelativePath("src/auth/session.ts")).toBe(true);
    expect(isSafeRelativePath("src/auth/**", true)).toBe(true);
    for (const path of [
      "../.env",
      "src/../.env",
      "/etc/passwd",
      "C:\\secrets.txt",
      "src/*.ts",
      "src//auth.ts",
      "src/\0auth.ts",
    ]) {
      expect(isSafeRelativePath(path, true), path).toBe(false);
    }
  });
});

describe("purpose-specific output and HTTP decision schemas", () => {
  it("accepts one allowed action and rejects a purpose-incompatible action", () => {
    expect(
      planIntentOutputSchema.safeParse({
        publicSummary: "I prepared a bounded implementation intent.",
        nextAction: {
          name: "relay_publish_intent",
          arguments: validEnvelope().payload,
        },
        taskState: "working",
      }).success,
    ).toBe(true);
    expect(
      planIntentOutputSchema.safeParse({
        publicSummary: "I completed implementation.",
        nextAction: {
          name: "relay_complete_task",
          arguments: {
            tests: [{ command: "npm test", status: "passed", summary: "green" }],
            changedFiles: ["src/auth/oauth.ts"],
            checkpointCommit: "7dedb3a",
          },
        },
        taskState: "completed",
      }).success,
    ).toBe(false);
  });

  it("requires approved paths only for approval decisions", () => {
    expect(
      contextRequestDecisionInputSchema.safeParse({
        ownerId: "bob",
        decision: "approve",
        targetVersion: 1,
        approvedPaths: [],
      }).success,
    ).toBe(false);
    expect(
      contextRequestDecisionInputSchema.safeParse({
        ownerId: "bob",
        decision: "deny",
        targetVersion: 1,
        approvedPaths: ["src/auth/**"],
      }).success,
    ).toBe(false);
  });

  it("rejects incomplete snapshots rather than making the UI infer fields", () => {
    expect(projectSnapshotSchema.safeParse({ project: { projectId: "phoenix" } }).success)
      .toBe(false);
  });

  it("defines a strict body schema for every mutating Telaegent route", () => {
    expect(Object.keys(telaegentHttpBodySchemas)).toEqual([
      "conversationMessage",
      "continueIntent",
      "completeIntent",
      "requestCoordinationStatus",
      "requestCoordinationProposal",
      "decideAgreement",
      "createContextRequest",
      "decideContextRequest",
      "generateContextPack",
      "publishDependencyChange",
      "requestReplan",
      "decidePlanRevision",
      "cancelOperation",
      "resetDemo",
    ]);
    expect(
      agreementDecisionHttpInputSchema.safeParse({
        ownerId: "alice",
        decision: "approve",
        targetVersion: 1,
        correlationId: "corr_01",
        idempotencyKey: "agreement_alice_v1",
        permissionClass: "DUAL_OWNER_COMMITMENT",
      }).success,
    ).toBe(false);
  });

  it("requires distinct Agents and bounded paths in context-request HTTP bodies", () => {
    const body = {
      senderOwnerId: "alice",
      senderAgentId: "alice-agent",
      recipientOwnerId: "bob",
      recipientAgentId: "bob-agent",
      topic: "Redis sessions",
      purpose: "Implement OAuth",
      requestedPaths: ["src/auth/**"],
      persistence: "current-task-only",
      expiresAt: "2026-08-28T02:15:00.000Z",
      correlationId: "corr_01",
      idempotencyKey: "ctx_01",
    };
    expect(contextRequestHttpInputSchema.safeParse(body).success).toBe(true);
    expect(
      contextRequestHttpInputSchema.safeParse({
        ...body,
        recipientAgentId: "alice-agent",
      }).success,
    ).toBe(false);
    expect(
      contextRequestDecisionHttpInputSchema.safeParse({
        ownerId: "bob",
        decision: "approve",
        targetVersion: 1,
        approvedPaths: ["src/auth/**"],
        correlationId: "corr_02",
        idempotencyKey: "ctx_decision_bob_v1",
      }).success,
    ).toBe(true);
  });
});
