import { describe, expect, it } from "vitest";
import { canHumanApprove, evaluatePermission } from "./permission-engine.js";
import { telagentEnvelopeSchema } from "./schemas.js";
import type { PermissionEvaluationContext, TelagentRequest } from "./types.js";

const baseRequest = (): TelagentRequest =>
  telagentEnvelopeSchema.parse({
    schemaVersion: "telagent.v1",
    requestId: "req_01",
    correlationId: "corr_01",
    idempotencyKey: "idem_01",
    projectId: "phoenix",
    conversationId: "conv_phoenix",
    intentId: "intent_alice",
    sender: { ownerId: "alice", agentId: "alice-agent", provider: "codex" },
    operation: "relay_publish_intent",
    payload: {
      task: "Add OAuth",
      branch: "feature/oauth",
      baseCommit: "7dedb3a",
      plannedFiles: ["src/auth/oauth.ts"],
      interfaces: ["Session"],
      dependencies: ["Session"],
      plan: ["Implement OAuth"],
    },
    delivery: {
      mode: "async",
      exchangeNumber: 1,
      createdAt: "2026-08-28T02:00:00.000Z",
      expiresAt: "2026-08-28T02:30:00.000Z",
    },
    evidence: { branch: "feature/oauth", baseCommit: "7dedb3a" },
  });

const context = (request = baseRequest()): PermissionEvaluationContext => ({
  request,
  authenticatedActor: {
    actorType: "agent",
    ownerId: "alice",
    agentId: "alice-agent",
    projectId: "phoenix",
    provider: "codex",
  },
  projectAgentIds: ["alice-agent", "bob-agent"],
  now: "2026-08-28T02:05:00.000Z",
});

const contextRequest = (requestedPaths = ["src/auth/**"], purpose = "Implement OAuth") =>
  telagentEnvelopeSchema.parse({
    ...baseRequest(),
    operation: "relay_request_context",
    recipient: { ownerId: "bob", agentId: "bob-agent" },
    payload: {
      topic: "Redis session architecture",
      purpose,
      requestedPaths,
      persistence: "current-task-only",
    },
  });

describe("permission engine", () => {
  it("allows validated same-project metadata", () => {
    expect(evaluatePermission(context())).toMatchObject({
      kind: "allow",
      permissionClass: "AUTO_METADATA",
    });
  });

  it("denies spoofed identity, provider, and project claims", () => {
    expect(
      evaluatePermission({
        ...context(),
        authenticatedActor: { ...context().authenticatedActor, ownerId: "mallory" },
      }),
    ).toMatchObject({ kind: "deny", code: "SENDER_IDENTITY_MISMATCH" });
    expect(
      evaluatePermission({
        ...context(),
        authenticatedActor: { ...context().authenticatedActor, provider: "claude" },
      }),
    ).toMatchObject({ kind: "deny", code: "PROVIDER_IDENTITY_MISMATCH" });
    expect(
      evaluatePermission({
        ...context(),
        authenticatedActor: { ...context().authenticatedActor, projectId: "other" },
      }),
    ).toMatchObject({ kind: "deny", code: "PROJECT_SCOPE_MISMATCH" });
  });

  it("asks the recipient owner for safe source context", () => {
    expect(evaluatePermission(context(contextRequest()))).toMatchObject({
      kind: "ask_human",
      permissionClass: "RECIPIENT_SOURCE_APPROVAL",
      approverOwnerIds: ["bob"],
    });
  });

  it("denies forbidden context before asking a human", () => {
    for (const paths of [[".env"], [".env.local"], [".git/**"], ["config/api-key.txt"]]) {
      expect(evaluatePermission(context(contextRequest(paths))), paths[0]).toMatchObject({
        kind: "deny",
        permissionClass: "ALWAYS_DENY",
      });
    }
    expect(
      evaluatePermission(context(contextRequest(["docs/**"], "Share the full private transcript"))),
    ).toMatchObject({ kind: "deny", code: "FORBIDDEN_INFORMATION_REQUEST" });
  });

  it("requires both owners for a resolution proposal", () => {
    const request = telagentEnvelopeSchema.parse({
      ...baseRequest(),
      operation: "relay_suggest_resolution",
      recipient: { ownerId: "bob", agentId: "bob-agent" },
      payload: {
        coordinationRequestId: "coord_01",
        conflictingIntentIds: ["intent_alice", "intent_bob"],
        proposalVersion: 1,
        ownership: [
          { ownerId: "alice", agentId: "alice-agent", files: ["src/auth/oauth.ts"], interfaces: ["OAuth"] },
          { ownerId: "bob", agentId: "bob-agent", files: ["src/auth/session.ts"], interfaces: ["Session"] },
        ],
        dependencyLinks: [{ consumerIntentId: "intent_alice", providerIntentId: "intent_bob", interface: "Session" }],
        requiredRules: ["Bob publishes Session changes"],
        rationale: "Split ownership",
      },
    });
    expect(
      evaluatePermission({ ...context(request), participantOwnerIds: ["alice", "bob"] }),
    ).toMatchObject({
      kind: "ask_human",
      permissionClass: "DUAL_OWNER_COMMITMENT",
      approverOwnerIds: ["alice", "bob"],
    });
  });

  it("routes plan revisions and stale status to the affected owner", () => {
    expect(
      evaluatePermission({ ...context(), statusStale: true, affectedOwnerId: "alice" }),
    ).toMatchObject({
      kind: "ask_human",
      permissionClass: "AFFECTED_OWNER_APPROVAL",
      approverOwnerIds: ["alice"],
    });
  });

  it("requires an existing unexpired source approval to create a pack", () => {
    const request = telagentEnvelopeSchema.parse({
      ...baseRequest(),
      operation: "relay_create_context_pack",
      recipient: { ownerId: "bob", agentId: "bob-agent" },
      payload: {
        contextRequestId: "ctx_01",
        topic: "Redis sessions",
        summary: "Use SessionRepository.",
        implementationSteps: ["Call SessionRepository"],
        validationChecklist: ["Test expiry"],
        sources: [{ path: "src/auth/session.ts", commit: "7dedb3a", sha256: "a".repeat(64) }],
        taskScope: "intent_alice",
        expiresAt: "2026-08-28T02:20:00.000Z",
      },
    });
    expect(evaluatePermission(context(request))).toMatchObject({
      kind: "deny",
      code: "SOURCE_APPROVAL_REQUIRED",
    });
    expect(
      evaluatePermission({
        ...context(request),
        existingApproval: {
          permissionClass: "RECIPIENT_SOURCE_APPROVAL",
          approvedByOwnerIds: ["bob"],
          approvedPaths: ["src/auth/**"],
          targetVersion: 1,
          expiresAt: "2026-08-28T02:15:00.000Z",
        },
      }),
    ).toMatchObject({ kind: "allow" });
  });

  it("does not let an Agent approve its own permission request", () => {
    const decision = evaluatePermission(context(contextRequest()));
    if (decision.kind !== "ask_human") throw new Error("Expected human decision");
    expect(canHumanApprove("agent", "bob", decision)).toBe(false);
    expect(canHumanApprove("human", "alice", decision)).toBe(false);
    expect(canHumanApprove("human", "bob", decision)).toBe(true);
  });

  it("denies expired requests", () => {
    expect(
      evaluatePermission({ ...context(), now: "2026-08-28T02:31:00.000Z" }),
    ).toMatchObject({ kind: "deny", code: "REQUEST_EXPIRED" });
  });
});
