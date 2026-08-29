export const TELAEGENT_SCHEMA_VERSION = "telaegent.v1" as const;

export const AGENT_PROVIDERS = ["codex", "claude"] as const;
export const RUN_PURPOSES = [
  "plan_intent",
  "implement",
  "status",
  "propose_resolution",
  "create_context_pack",
  "publish_dependency_change",
  "revise_plan",
] as const;
export const SESSION_MODES = ["continue", "fresh", "ephemeral"] as const;
export const SANDBOX_MODES = ["read-only", "workspace-write"] as const;

export const TELAEGENT_TOOL_NAMES = [
  "relay_publish_intent",
  "relay_update_progress",
  "relay_ask_status",
  "relay_reply",
  "relay_suggest_resolution",
  "relay_request_context",
  "relay_create_context_pack",
  "relay_report_dependency_change",
  "relay_propose_replan",
  "relay_complete_task",
  "relay_request_human_decision",
] as const;

export const PERMISSION_CLASSES = [
  "AUTO_METADATA",
  "RECIPIENT_SOURCE_APPROVAL",
  "DUAL_OWNER_COMMITMENT",
  "AFFECTED_OWNER_APPROVAL",
  "ALWAYS_DENY",
] as const;

export const OPERATION_STATES = [
  "accepted",
  "queued",
  "running",
  "waiting_for_recipient",
  "input_required",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "escalated",
] as const;
export const COORDINATION_STATES = [
  "detected",
  "status_pending",
  "proposal_ready",
  "awaiting_approvals",
  "active",
  "rejected",
  "escalated",
  "expired",
  "completed",
] as const;
export const CONTEXT_REQUEST_STATES = [
  "requested",
  "approved",
  "denied",
  "generating",
  "validated",
  "delivered",
  "rejected",
  "expired",
] as const;
export const PLAN_REVISION_STATES = [
  "proposed",
  "approved",
  "rejected",
  "applied",
] as const;
export const INTENT_STATES = [
  "planning",
  "active",
  "coordination_required",
  "implementing",
  "awaiting_context",
  "awaiting_replan",
  "completed",
  "failed",
  "cancelled",
] as const;
export const AGREEMENT_STATES = [
  "proposed",
  "active",
  "rejected",
  "superseded",
  "completed",
] as const;
export const CONTEXT_PACK_STATES = [
  "candidate",
  "validated",
  "delivered",
  "rejected",
  "expired",
] as const;

export const TELAEGENT_ERROR_CODES = [
  "INVALID_REQUEST",
  "POLICY_DENIED",
  "NOT_FOUND",
  "INVALID_STATE",
  "AGENT_BUSY",
  "EXPIRED",
  "STALE_VERSION",
  "INVALID_AGENT_OUTPUT",
  "OWNERSHIP_VIOLATION",
  "EXCHANGE_LIMIT",
  "RUNTIME_UNAVAILABLE",
] as const;

export const TELAEGENT_ERROR_HTTP_STATUS = {
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
} as const;

export const TELAEGENT_LIMITS = {
  idLength: 128,
  summaryLength: 1_000,
  taskLength: 2_000,
  purposeLength: 1_000,
  rationaleLength: 2_000,
  pathLength: 512,
  branchLength: 255,
  planSteps: 12,
  files: 20,
  interfaces: 20,
  dependencies: 20,
  blockers: 8,
  sourceRefs: 8,
  approvedPathRules: 5,
  contextPackJsonBytes: 8 * 1_024,
  contextPackTtlMs: 15 * 60 * 1_000,
  coordinationTtlMs: 30 * 60 * 1_000,
  staleStatusMs: 5 * 60 * 1_000,
  maxRequestTtlMs: 30 * 60 * 1_000,
  maxClockSkewMs: 30 * 1_000,
  idempotencyRetentionMs: 30 * 60 * 1_000,
  maxExchangeNumber: 3,
  maxAgentSteps: 3,
} as const;
