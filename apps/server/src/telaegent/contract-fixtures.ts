import type {
  AllowedAction,
  ConversationEntryPayloadByType,
  IdempotencyRecord,
  PayloadByOperation,
  TelaegentDatabase,
  TelaegentEnvelopeBase,
  TelaegentToolName,
} from "./types.js";

const createdAt = "2026-08-28T02:00:00.000Z";
const expiresAt = "2026-08-28T02:15:00.000Z";
const sha256 = "a".repeat(64);

export const TOOL_PAYLOAD_FIXTURES = {
  relay_publish_intent: {
    task: "Add Google OAuth",
    branch: "feature/google-oauth",
    baseCommit: "af31d4e",
    plannedFiles: ["src/auth/oauth.ts", "src/routes/oauth-callback.ts"],
    interfaces: ["Session", "GET /oauth/callback"],
    dependencies: ["User", "Session"],
    plan: ["Add the provider adapter", "Implement and test the callback route"],
  },
  relay_update_progress: {
    changedFiles: ["src/auth/oauth.ts"],
    progress: 60,
    blockers: [],
    verifiedAt: createdAt,
  },
  relay_ask_status: {
    targetIntentId: "intent_bob_redis",
    purpose: "Check the current Session contract before implementing OAuth",
  },
  relay_reply: {
    replyToRequestId: "req_status_01",
    responseKind: "status",
    body: {
      task: "Migrate session storage to Redis",
      state: "in_progress",
      branch: "feature/redis-sessions",
      changedFiles: ["src/auth/session.ts"],
      interfaces: ["Session"],
      progress: 60,
      blockers: [],
      lastVerifiedAt: createdAt,
      stale: false,
    },
  },
  relay_suggest_resolution: {
    coordinationRequestId: "coord_01",
    conflictingIntentIds: ["intent_alice_oauth", "intent_bob_redis"],
    proposalVersion: 1,
    ownership: [
      {
        ownerId: "alice",
        agentId: "alice-agent",
        files: ["src/auth/oauth.ts", "src/routes/oauth-callback.ts"],
        interfaces: ["OAuthProvider"],
      },
      {
        ownerId: "bob",
        agentId: "bob-agent",
        files: ["src/auth/session.ts"],
        interfaces: ["Session", "SessionRepository"],
      },
    ],
    dependencyLinks: [
      {
        consumerIntentId: "intent_alice_oauth",
        providerIntentId: "intent_bob_redis",
        interface: "Session",
      },
    ],
    requiredRules: ["Bob must publish every Session contract change"],
    rationale: "Keep OAuth routing separate from Redis-backed session ownership.",
  },
  relay_request_context: {
    topic: "Redis session architecture",
    purpose: "Implement Google OAuth",
    requestedPaths: ["docs/architecture/**", "src/auth/**", "tests/auth/**"],
    persistence: "current-task-only",
  },
  relay_create_context_pack: {
    contextRequestId: "ctx_01",
    topic: "Redis session architecture",
    summary: "Authenticated routes use SessionRepository instead of direct Redis access.",
    implementationSteps: ["Use the existing SessionRepository", "Apply session expiry"],
    validationChecklist: ["Logout removes the key", "Tests use the fake repository"],
    sources: [{ path: "src/auth/session.ts", commit: "af31d4e", sha256 }],
    taskScope: "intent_alice_oauth",
    expiresAt,
  },
  relay_report_dependency_change: {
    interface: "SessionRepository.create",
    change: "The method now requires deviceId",
    sourcePath: "src/auth/session-repository.ts",
    commit: "bf4812c",
  },
  relay_propose_replan: {
    dependencyChangeId: "dep_01",
    originalSteps: ["Create a session after the OAuth callback"],
    revisedSteps: [
      "Extract deviceId from the validated request context",
      "Pass deviceId to SessionRepository.create",
      "Update OAuth callback tests",
    ],
    affectedFiles: ["src/routes/oauth-callback.ts", "tests/oauth.test.ts"],
  },
  relay_complete_task: {
    tests: [{ command: "npm test", status: "passed", summary: "All OAuth tests pass" }],
    changedFiles: ["src/auth/oauth.ts", "src/routes/oauth-callback.ts"],
    checkpointCommit: "cf5812d",
  },
  relay_request_human_decision: {
    reasonCode: "AMBIGUOUS_RESOLUTION",
    reason: "The ownership proposal has two safe alternatives.",
    options: [
      { id: "revise", label: "Revise proposal", safeDescription: "Ask for a narrower split" },
      { id: "escalate", label: "Escalate", safeDescription: "Pause and ask the owners" },
    ],
  },
} as const satisfies PayloadByOperation;

function envelope<TOperation extends TelaegentToolName>(
  operation: TOperation,
  payload: PayloadByOperation[TOperation],
): TelaegentEnvelopeBase<TOperation, PayloadByOperation[TOperation]> {
  return {
    schemaVersion: "telaegent.v1",
    requestId: `req_${operation}`,
    correlationId: `corr_${operation}`,
    idempotencyKey: `idem_${operation}`,
    projectId: "phoenix",
    conversationId: "conv_phoenix_demo",
    intentId: "intent_alice_oauth",
    sender: { ownerId: "alice", agentId: "alice-agent", provider: "codex" },
    recipient: { ownerId: "bob", agentId: "bob-agent" },
    operation,
    payload,
    delivery: {
      mode: "async",
      exchangeNumber: 1,
      createdAt,
      expiresAt,
      ...(operation === "relay_reply" ? { replyToRequestId: "req_status_01" } : {}),
    },
    evidence: { branch: "feature/google-oauth", baseCommit: "af31d4e" },
  };
}

export const TELAEGENT_ENVELOPE_FIXTURES = {
  relay_publish_intent: envelope("relay_publish_intent", TOOL_PAYLOAD_FIXTURES.relay_publish_intent),
  relay_update_progress: envelope("relay_update_progress", TOOL_PAYLOAD_FIXTURES.relay_update_progress),
  relay_ask_status: envelope("relay_ask_status", TOOL_PAYLOAD_FIXTURES.relay_ask_status),
  relay_reply: envelope("relay_reply", TOOL_PAYLOAD_FIXTURES.relay_reply),
  relay_suggest_resolution: envelope("relay_suggest_resolution", TOOL_PAYLOAD_FIXTURES.relay_suggest_resolution),
  relay_request_context: envelope("relay_request_context", TOOL_PAYLOAD_FIXTURES.relay_request_context),
  relay_create_context_pack: envelope("relay_create_context_pack", TOOL_PAYLOAD_FIXTURES.relay_create_context_pack),
  relay_report_dependency_change: envelope("relay_report_dependency_change", TOOL_PAYLOAD_FIXTURES.relay_report_dependency_change),
  relay_propose_replan: envelope("relay_propose_replan", TOOL_PAYLOAD_FIXTURES.relay_propose_replan),
  relay_complete_task: envelope("relay_complete_task", TOOL_PAYLOAD_FIXTURES.relay_complete_task),
  relay_request_human_decision: envelope("relay_request_human_decision", TOOL_PAYLOAD_FIXTURES.relay_request_human_decision),
} as const;

export const CONVERSATION_ENTRY_PAYLOAD_FIXTURES = {
  human_message: { content: "Add Google OAuth" },
  agent_summary: { summary: "OAuth depends on Session.", taskState: "working" },
  tool_call: {
    action: { name: "relay_publish_intent", arguments: TOOL_PAYLOAD_FIXTURES.relay_publish_intent },
  },
  tool_result: { toolName: "relay_publish_intent", outcome: "completed", safeSummary: "Intent published" },
  permission_request: { permissionClass: "DUAL_OWNER_COMMITMENT", approverOwnerIds: ["alice", "bob"], purpose: "Activate the ownership agreement", expiresAt },
  permission_decision: { ownerId: "alice", decision: "approve", targetVersion: 1 },
  context_pack: { artifactId: "pack_01", topic: "Redis sessions", summary: "Use SessionRepository.", expiresAt },
  dependency_change: { dependencyChangeId: "dep_01", ...TOOL_PAYLOAD_FIXTURES.relay_report_dependency_change },
  plan_diff: { revisionId: "revision_01", ...TOOL_PAYLOAD_FIXTURES.relay_propose_replan },
  system_event: { eventType: "conflict_detected", safeSummary: "Coordination is required" },
  error: { code: "POLICY_DENIED", message: "The requested path is forbidden", auditEventId: "evt_01" },
} as const satisfies ConversationEntryPayloadByType;

export const ALLOWED_ACTION_FIXTURES = [
  { kind: "continue_intent", intentId: "intent_alice_oauth", expectedVersion: 1 },
  { kind: "complete_intent", intentId: "intent_alice_oauth", expectedVersion: 1 },
  { kind: "request_status", coordinationRequestId: "coord_01", expectedVersion: 1 },
  { kind: "request_proposal", coordinationRequestId: "coord_01", expectedVersion: 1 },
  { kind: "decide_agreement", agreementId: "agreement_01", expectedVersion: 1 },
  { kind: "decide_context_request", requestId: "ctx_01", expectedVersion: 1 },
  { kind: "generate_context_pack", requestId: "ctx_01", expectedVersion: 1 },
  { kind: "report_dependency_change", intentId: "intent_bob_redis", expectedVersion: 1 },
  { kind: "request_replan", revisionId: "revision_01", expectedVersion: 1 },
  { kind: "decide_plan_revision", revisionId: "revision_01", expectedVersion: 1 },
  { kind: "cancel_operation", operationId: "op_01" },
] as const satisfies readonly AllowedAction[];

export const IDEMPOTENCY_RECORD_FIXTURE: IdempotencyRecord = {
  projectId: "phoenix",
  senderAgentId: "alice-agent",
  operation: "relay_publish_intent",
  idempotencyKey: "idem_publish_alice",
  requestFingerprint: sha256,
  requestId: "req_publish_alice",
  operationId: "op_publish_alice",
  expiresAt,
  createdAt,
};

export const EMPTY_TELAEGENT_DATABASE: TelaegentDatabase = {
  projects: [],
  owners: [],
  agentBindings: [],
  conversations: [],
  conversationEntries: [],
  intents: [],
  coordinationRequests: [],
  agreements: [],
  contextRequests: [],
  contextPacks: [],
  dependencyChanges: [],
  planRevisions: [],
  operations: [],
  events: [],
  idempotencyRecords: [],
};
