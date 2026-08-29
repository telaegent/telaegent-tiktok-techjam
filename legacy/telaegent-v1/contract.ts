/**
 * WORKSTREAM #6 CONTRACT ADAPTER.
 *
 * Duy's `types.ts` / `constants.ts` / `schemas.ts` are now the shared contract.
 * This file no longer *declares* that contract — it re-exports it, and adds the
 * handful of things workstream #6 needs that the shared contract does not
 * provide. Everything in #6 still imports from `./contract.js` only, so there is
 * exactly one place to look when the contract moves again.
 *
 * Three additions, each with a reason:
 *   1. CONTEXT_LIMITS  — TELAEGENT_LIMITS is missing the two per-file byte caps
 *                        from plan.md §12.3. Raised with Duy; defined here so
 *                        the isolation code is not silently unbounded.
 *   2. DenialCode      — the shared contract types a denial `code` as `string`.
 *                        #6 needs the exact rule identifiers, because they are
 *                        rendered on the denial card and asserted in tests.
 *   3. ResolvedSourceGrant — see the note below (finding C5).
 */

export * from "./types.js";
export * from "./constants.js";
// Phuong owns the runtime vocabulary. #6 consumes it; it is re-exported here so
// the workstream still has exactly one import surface.
export type {
  AgentProvider,
  RunPurpose,
  SessionMode,
  NetworkMode,
  MiddlewareRunRequest,
  NormalizedRunResult,
} from "../runtime-contract.js";
export type { MiddlewareSandboxMode as SandboxMode } from "../runtime-contract.js";

import { TELAEGENT_LIMITS } from "./constants.js";
import type {
  Agreement,
  ExistingApprovalScope,
  UtcTimestamp,
} from "./types.js";

/* ========================================================================== *
 * 1. Limits
 * ========================================================================== */

/**
 * REQUEST TO DUY: `maxBytesPerFile` and `maxTotalSourceBytes` are in
 * `plan.md` §12.3 but not in `TELAEGENT_LIMITS`. Without them the isolated
 * workspace has no byte budget at all — only a file count. They are defined
 * here so the behaviour is correct today; move them into `constants.ts` and
 * this block becomes a straight re-export.
 */
export const CONTEXT_LIMITS = Object.freeze({
  maxApprovedRules: TELAEGENT_LIMITS.approvedPathRules,
  maxSourceFiles: TELAEGENT_LIMITS.sourceRefs,
  maxPackBytes: TELAEGENT_LIMITS.contextPackJsonBytes,
  packTtlMs: TELAEGENT_LIMITS.contextPackTtlMs,
  statusStaleAfterMs: TELAEGENT_LIMITS.staleStatusMs,
  coordinationTtlMs: TELAEGENT_LIMITS.coordinationTtlMs,
  maxExchanges: TELAEGENT_LIMITS.maxExchangeNumber,
  maxAgentSteps: TELAEGENT_LIMITS.maxAgentSteps,
  maxPublicSummaryChars: TELAEGENT_LIMITS.summaryLength,

  // Not yet in the shared contract — see the note above.
  maxBytesPerFile: 32 * 1_024,
  maxTotalSourceBytes: 64 * 1_024,
});

/* ========================================================================== *
 * 2. Denial codes
 * ========================================================================== */

export const DENIAL_CODES = [
  "FORBID_EMPTY_PATH",
  "FORBID_NUL_BYTE",
  "FORBID_ABSOLUTE_PATH",
  "FORBID_DRIVE_OR_UNC",
  "FORBID_TRAVERSAL",
  "FORBID_UNSUPPORTED_GLOB",
  "FORBID_ENV_FILES",
  "FORBID_GIT_INTERNALS",
  "FORBID_SECRET_NAME",
  "FORBID_PRIVATE_KEY_FILE",
  "FORBID_PROVIDER_HOME",
  "FORBID_OUTSIDE_WORKSPACE",
  "FORBID_SYMLINK_ESCAPE",
  "FORBID_NOT_REGULAR_FILE",
  "FORBID_UNAPPROVED_PATH",
  "LIMIT_TOO_MANY_RULES",
  "LIMIT_TOO_MANY_FILES",
  "LIMIT_FILE_TOO_LARGE",
  "LIMIT_TOTAL_TOO_LARGE",
  "LIMIT_PACK_TOO_LARGE",
  "PACK_NO_SOURCES",
  "PACK_STALE_SOURCE",
  "PACK_SCOPE_MISMATCH",
  "PACK_EXPIRED",
  "PACK_SECRET_CONTENT",
  "PACK_INJECTION_INDICATORS",
  "OWNERSHIP_VIOLATION",
  "TOOL_NOT_DISPATCHABLE",
  "PERMISSION_NOT_RESOLVED",
] as const;

export type DenialCode = (typeof DENIAL_CODES)[number];

/* ========================================================================== *
 * 3. The resolved source grant  (finding C5, resolved)
 * ========================================================================== */

/**
 * Duy solved C5 from the other side: `evaluatePermission` takes the approval as
 * `PermissionEvaluationContext.existingApproval` and, for
 * `relay_create_context_pack`, returns a plain `allow` once that approval is
 * usable. That is sound — but the decision itself carries only
 * `{ approvalVersion, sourcePaths }` in an `unknown` safeScope, and the isolated
 * workspace also needs the commit the approval was pinned to, its expiry, and
 * the task scope.
 *
 * Rather than widen Duy's decision type, Khoa passes the same
 * `ExistingApprovalScope` he already loaded to build the evaluation context
 * straight through to `DispatchContext.sourceGrant`. No contract change, and the
 * dispatcher still never reads approval state itself.
 */
export interface ResolvedSourceGrant extends ExistingApprovalScope {
  permissionClass: "RECIPIENT_SOURCE_APPROVAL";
  contextRequestId: string;
  /** Exactly what the human approved. Not what the model asked for. */
  approvedPaths: string[];
  /** Commit the approval was pinned to; a pack built off any other is stale. */
  sourceCommit: string;
  taskScope: string;
}

/* ========================================================================== *
 * Narrow views — #6 accepts the smallest shape it needs, so Duy's full records
 * are structurally assignable and tests stay readable. Mirrors his own
 * `ConflictIntentView` idiom.
 * ========================================================================== */

export interface ImpactIntentView {
  intentId: string;
  ownerId: string;
  agentId: string;
  interfaces: string[];
  dependencies: string[];
}

/** What a published dependency change looks like before it becomes a record. */
export interface DependencyChangeView {
  dependencyChangeId: string;
  /** Publisher's intent. Never reported as impacted by its own change. */
  intentId: string;
  agentId: string;
  ownerId: string;
  /** Primary contract that changed, e.g. `Session`. */
  interface: string;
  /**
   * REQUEST TO DUY: additional identifiers the change also touches.
   * `plan.md` §14.2 says to find intents declaring "Session OR
   * SessionRepository", but `ReportDependencyChangeInput` has a single
   * `interface` field. Optional, so his shape remains valid without it.
   */
  relatedInterfaces?: string[] | undefined;
  change: string;
  sourcePath: string;
  commit: string;
}

/** Duy's Agreement, narrowed to what the ownership gate reads. */
export type ActiveAgreement = Pick<
  Agreement,
  "agreementId" | "proposalVersion" | "state" | "ownership" | "dependencyLinks" | "requiredRules"
>;

/* ========================================================================== *
 * Safe outputs — #6 produces these; Khoa persists them.
 * ========================================================================== */

export interface SafeConversationEntry {
  type: import("./types.js").ConversationEntryType;
  actorOwnerId: string | null;
  actorAgentId: string | null;
  /** Already redacted, already length-bounded. */
  payload: Record<string, unknown>;
  correlationId: string;
}

export interface SafeAuditHint {
  eventType: string;
  outcome: "allowed" | "denied" | "failed" | "recorded";
  actorOwnerId: string | null;
  actorAgentId: string | null;
  /** Rule id or safe relative path only — never content. */
  safePayload: Record<string, string | number | boolean | null>;
  correlationId: string;
}

/** The validated pack #6 hands back: Duy's `ContextPack`, pinned to `validated`. */
export interface ValidatedContextPack
  extends Omit<import("./types.js").ContextPack, "createdAt" | "updatedAt" | "state"> {
  state: "validated";
  /** Serialized size, measured on the object that would actually be stored. */
  bytes: number;
}

/** The candidate a provider returns, before validation. Duy's tool input. */
export type ContextPackCandidate = import("./types.js").CreateContextPackInput;

export type { UtcTimestamp };
