/**
 * TOOL DISPATCHER — executes authorized logical tool calls and nothing else.
 *
 * Four invariants, each one a test:
 *   1. Arguments are re-parsed with the tool's schema here, even though the
 *      permission engine already parsed them. Cheap, and it means a bug
 *      upstream cannot turn into a filesystem operation.
 *   2. A call arrives with a decision. If that decision is not a resolved
 *      `allow`, the dispatcher refuses. It never reads approval state, so it
 *      can never approve itself (findings C5, C13).
 *   3. No store writes. Executors return safe DTOs; Khoa persists them inside
 *      the same atomic mutation as the audit event.
 *   4. No runner call. Provider work goes through `ports.runMiddlewareTurn`,
 *      which is Khoa's wrapper over AgentService (finding C6).
 *
 * There is no code path here that takes a model-supplied string and turns it
 * into a command name, a shell fragment, or a permission.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CONTEXT_LIMITS,
  DENIAL_CODES,
  type DenialCode,
  type PermissionDecision,
  type ResolvedSourceGrant,
  type SafeConversationEntry,
  type TelagentToolName,
} from "./contract.js";
import { normalizeRuleSet, normalizeSourcePath } from "./context-policy.js";
import { withApprovedContextWorkspace } from "./context-workspace.js";
import { validateContextPack, type ValidationRequestState } from "./context-pack-validator.js";
import { detectDependencyImpact, validatePlanRevision } from "./dependency-impact.js";
import {
  compareReportedChanges,
  createCheckpointCommit,
  currentCommit,
  statusChangedPaths,
  validateChangedPaths,
} from "./git-helper.js";
import type {
  AuthorizedToolCall,
  DispatchContext,
  TelagentPorts,
  ToolExecutionResult,
} from "./ports.js";
import { toSafeSummary } from "./redaction.js";
import { TOOL_ARGUMENT_SCHEMAS } from "./tool-schemas.js";

/* ========================================================================== *
 * Tools the dispatcher will never execute
 * ========================================================================== */

/**
 * FINDING C13. `relay_request_human_decision` is a real Agent-callable tool,
 * but its only correct outcome is a paused Operation and a human card. If it
 * ever reaches the dispatcher carrying an allow, something upstream is wrong
 * and the safe response is refusal, not execution.
 */
export const NEVER_DISPATCHABLE: readonly TelagentToolName[] = [
  "relay_request_human_decision",
];

const deny = (code: DenialCode, safeReason: string): ToolExecutionResult => ({
  kind: "denied",
  code,
  safeReason,
});

const entry = (
  type: SafeConversationEntry["type"],
  call: AuthorizedToolCall,
  payload: Record<string, unknown>,
): SafeConversationEntry => ({
  type,
  actorOwnerId: call.actor.ownerId,
  actorAgentId: call.actor.agentId,
  payload,
  correlationId: call.correlationId,
});

/* ========================================================================== *
 * Entry point
 * ========================================================================== */

export async function executeToolCall(
  call: AuthorizedToolCall,
  context: DispatchContext,
  ports: TelagentPorts,
): Promise<ToolExecutionResult> {
  // Invariant 2, before anything else.
  if (NEVER_DISPATCHABLE.includes(call.name)) {
    return deny(
      "TOOL_NOT_DISPATCHABLE",
      "This tool pauses for a human decision and is never executed by the server.",
    );
  }
  const authorization = requireResolvedAllow(call.permissionDecision);
  if (!authorization.ok) return authorization.result;

  // Invariant 1.
  const schema = TOOL_ARGUMENT_SCHEMAS[call.name] as z.ZodType<unknown> | undefined;
  if (!schema) {
    return deny("TOOL_NOT_DISPATCHABLE", "Unknown tool.");
  }
  const parsed = schema.safeParse(call.arguments);
  if (!parsed.success) {
    return {
      kind: "escalate",
      code: "INVALID_AGENT_OUTPUT",
      safeReason:
        "Tool arguments failed validation: " +
        parsed.error.issues
          .slice(0, 3)
          .map((issue) => issue.path.join(".") || "(root)")
          .join(", "),
    };
  }

  if (context.exchangeNumber > CONTEXT_LIMITS.maxExchanges) {
    return {
      kind: "escalate",
      code: "EXCHANGE_LIMIT",
      safeReason: "The bounded coordination limit was reached; a human must continue.",
    };
  }

  switch (call.name) {
    case "relay_publish_intent":
      return publishIntent(call, parsed.data, ports);
    case "relay_update_progress":
      return updateProgress(call, parsed.data, context, ports);
    case "relay_ask_status":
      return askStatus(call, parsed.data, context, ports);
    case "relay_reply":
      return reply(call, parsed.data, context);
    case "relay_suggest_resolution":
      return suggestResolution(call, parsed.data);
    case "relay_request_context":
      return requestContext(call, parsed.data);
    case "relay_create_context_pack":
      return createContextPack(call, parsed.data, context, ports);
    case "relay_report_dependency_change":
      return reportDependencyChange(call, parsed.data, context);
    case "relay_propose_replan":
      return proposeReplan(call, parsed.data, context);
    case "relay_complete_task":
      return completeTask(call, parsed.data, context, ports);
    /* c8 ignore next 2 */
    default:
      return deny("TOOL_NOT_DISPATCHABLE", "Unknown tool.");
  }
}

type Authorization = { ok: true } | { ok: false; result: ToolExecutionResult };

function requireResolvedAllow(decision: PermissionDecision): Authorization {
  if (decision.kind === "deny") {
    // The shared contract types a denial code as `string`; #6 only understands
    // its own rule identifiers, so anything else is reported generically rather
    // than passed through as if it were one.
    const code = (DENIAL_CODES as readonly string[]).includes(decision.code)
      ? (decision.code as DenialCode)
      : "TOOL_NOT_DISPATCHABLE";
    return { ok: false, result: deny(code, decision.safeReason) };
  }
  if (decision.kind === "ask_human") {
    return {
      ok: false,
      result: deny(
        "PERMISSION_NOT_RESOLVED",
        "This call still needs a human decision and cannot be executed.",
      ),
    };
  }
  // Duy's allow decision carries only `{approvalVersion, sourcePaths}` in an
  // `unknown` safeScope. The full grant travels in DispatchContext, supplied by
  // Khoa from the same record he used to evaluate permission (finding C5).
  return { ok: true };
}

/* ========================================================================== *
 * Executors — metadata
 * ========================================================================== */

type Args<K extends TelagentToolName> = z.infer<(typeof TOOL_ARGUMENT_SCHEMAS)[K]>;

async function publishIntent(
  call: AuthorizedToolCall,
  raw: unknown,
  ports: TelagentPorts,
): Promise<ToolExecutionResult> {
  const args = raw as Args<"relay_publish_intent">;

  const planned: string[] = [];
  for (const file of args.plannedFiles) {
    const normalized = normalizeSourcePath(file);
    if (!normalized.ok) return deny(normalized.code, normalized.safeReason);
    planned.push(normalized.value);
  }

  ports.auditHint({
    eventType: "intent_published",
    outcome: "allowed",
    actorOwnerId: call.actor.ownerId,
    actorAgentId: call.actor.agentId,
    safePayload: { branch: args.branch, plannedFileCount: planned.length },
    correlationId: call.correlationId,
  });

  return {
    kind: "artifact",
    entry: entry("tool_result", call, {
      tool: call.name,
      task: toSafeSummary(args.task, 500),
      branch: args.branch,
      plannedFiles: planned,
      interfaces: args.interfaces,
      dependencies: args.dependencies,
      plan: args.plan.map((step) => toSafeSummary(step, 200)),
    }),
    evidence: { branch: args.branch, commit: args.baseCommit },
    record: {
      kind: "intent",
      task: args.task,
      branch: args.branch,
      baseCommit: args.baseCommit,
      plannedFiles: planned,
      interfaces: args.interfaces,
      dependencies: args.dependencies,
      planSteps: args.plan,
    },
  };
}

async function updateProgress(
  call: AuthorizedToolCall,
  raw: unknown,
  context: DispatchContext,
  ports: TelagentPorts,
): Promise<ToolExecutionResult> {
  const args = raw as Args<"relay_update_progress">;

  // Git, not the model, decides what changed (finding C9).
  const status = await statusChangedPaths(context.workspacePath, ports.git);
  const gitPaths = status.ok ? status.value : [];
  const comparison = compareReportedChanges(gitPaths, args.changedFiles);

  if (!comparison.agreed) {
    ports.auditHint({
      eventType: "changed_files_mismatch",
      outcome: "recorded",
      actorOwnerId: call.actor.ownerId,
      actorAgentId: call.actor.agentId,
      safePayload: {
        missingFromReport: comparison.missingFromReport.length,
        notInGit: comparison.notInGit.length,
      },
      correlationId: call.correlationId,
    });
  }

  return {
    kind: "artifact",
    entry: entry("tool_result", call, {
      tool: call.name,
      progress: args.progress,
      changedFiles: gitPaths,
      blockers: args.blockers.map((blocker) => toSafeSummary(blocker, 200)),
      verifiedAt: args.verifiedAt,
      reportMatchedGit: comparison.agreed,
    }),
    evidence: { changedFiles: gitPaths },
    record: {
      kind: "progress",
      intentId: context.intentId ?? null,
      progress: args.progress,
      changedFiles: gitPaths,
      blockers: args.blockers,
      verifiedAt: args.verifiedAt,
    },
  };
}

/* ========================================================================== *
 * Executors — cross-Agent
 * ========================================================================== */

const statusResultSchema = z
  .object({
    publicSummary: z.string().trim().max(CONTEXT_LIMITS.maxPublicSummaryChars),
    taskState: z.enum(["working", "blocked", "completed"]),
    progress: z.number().int().min(0).max(100),
    changedFiles: z.array(z.string().max(400)).max(20),
    interfaces: z.array(z.string().max(120)).max(20),
    blockers: z.array(z.string().max(400)).max(8),
    lastVerifiedAt: z.string(),
  })
  .strip();

/**
 * Bounded status from the recipient's private session. The provider is reached
 * through the injected port; this module never touches a runner (C6).
 */
async function askStatus(
  call: AuthorizedToolCall,
  raw: unknown,
  context: DispatchContext,
  ports: TelagentPorts,
): Promise<ToolExecutionResult> {
  const args = raw as Args<"relay_ask_status">;

  // The tool names the intent, not the agent. The recipient is resolved from
  // state Khoa supplied — a model-supplied agent id is never trusted as a
  // routing decision.
  const target = context.activeIntents.find(
    (intent) => intent.intentId === args.targetIntentId,
  );
  if (!target) {
    return deny("TOOL_NOT_DISPATCHABLE", "The named intent is not active in this project.");
  }
  if (target.agentId === call.actor.agentId) {
    return deny("TOOL_NOT_DISPATCHABLE", "An Agent cannot request status from itself.");
  }

  const run = await ports.runMiddlewareTurn({
    agentId: target.agentId,
    provider: context.provider,
    purpose: "status",
    workspacePath: context.workspacePath,
    runtimePrompt: "",
    persistedSummary: "Bounded status request: " + toSafeSummary(args.purpose, 200),
    sessionMode: "continue",
    sandboxMode: "read-only",
    networkMode: "none",
    outputSchemaName: "status.schema.json",
    correlationId: call.correlationId,
    maxTurns: 1,
  });

  const parsed = statusResultSchema.safeParse(run.final);
  if (!parsed.success) {
    return {
      kind: "escalate",
      code: "INVALID_AGENT_OUTPUT",
      safeReason: "The recipient's status did not match its schema.",
    };
  }

  const staleAfter = ports.now().getTime() - CONTEXT_LIMITS.statusStaleAfterMs;
  const verified = new Date(parsed.data.lastVerifiedAt).getTime();
  const stale = !Number.isFinite(verified) || verified < staleAfter;

  return {
    kind: "artifact",
    entry: entry("tool_result", call, {
      tool: call.name,
      recipientAgentId: target.agentId,
      publicSummary: toSafeSummary(parsed.data.publicSummary, CONTEXT_LIMITS.maxPublicSummaryChars),
      taskState: parsed.data.taskState,
      progress: parsed.data.progress,
      changedFiles: parsed.data.changedFiles.slice(0, 20),
      interfaces: parsed.data.interfaces,
      blockers: parsed.data.blockers.map((blocker) => toSafeSummary(blocker, 200)),
      lastVerifiedAt: parsed.data.lastVerifiedAt,
      // Stale status must not silently support a consequential activation.
      stale,
    }),
    record: { kind: "status", stale, ...parsed.data },
  };
}

/**
 * A reply inherits its request's recipient, scope, version and expiry. It can
 * narrow nothing and expand nothing — it is not a way to create a new grant.
 */
async function reply(
  call: AuthorizedToolCall,
  raw: unknown,
  context: DispatchContext,
): Promise<ToolExecutionResult> {
  const args = raw as Args<"relay_reply">;
  const pending = context.pendingRequest;

  if (!pending) {
    return deny("TOOL_NOT_DISPATCHABLE", "There is no pending request to reply to.");
  }
  if (pending.requestId !== args.replyToRequestId) {
    return deny("TOOL_NOT_DISPATCHABLE", "The reply targets a different request.");
  }
  if (pending.recipientAgentId !== call.actor.agentId) {
    return deny("TOOL_NOT_DISPATCHABLE", "Only the request's recipient may reply.");
  }

  const bodyKeys = Object.keys(args.body);
  if (bodyKeys.length > 20) {
    return deny("TOOL_NOT_DISPATCHABLE", "The reply body is too large.");
  }

  return {
    kind: "artifact",
    entry: entry("tool_result", call, {
      tool: call.name,
      replyToRequestId: pending.requestId,
      responseKind: args.responseKind,
      // Inherited, never taken from the arguments.
      recipientAgentId: pending.recipientAgentId,
      version: pending.version,
      expiresAt: pending.expiresAt,
      purpose: pending.purpose,
      fields: bodyKeys.sort(),
    }),
    record: {
      kind: "reply",
      replyToRequestId: pending.requestId,
      responseKind: args.responseKind,
      version: pending.version,
      expiresAt: pending.expiresAt,
    },
  };
}

async function suggestResolution(
  call: AuthorizedToolCall,
  raw: unknown,
): Promise<ToolExecutionResult> {
  const args = raw as Args<"relay_suggest_resolution">;

  const owners = new Set(args.ownership.map((rule) => rule.ownerId));
  if (owners.size !== 2) {
    return deny("TOOL_NOT_DISPATCHABLE", "A resolution must divide work between two owners.");
  }
  for (const rule of args.ownership) {
    for (const candidate of rule.files) {
      const normalized = normalizeSourcePath(candidate.replace(/\/\*\*$/, ""));
      if (!normalized.ok) return deny(normalized.code, normalized.safeReason);
    }
  }

  return {
    kind: "artifact",
    entry: entry("tool_call", call, {
      tool: call.name,
      proposalVersion: args.proposalVersion,
      conflictingIntentIds: args.conflictingIntentIds,
      ownership: args.ownership,
      dependencyLinks: args.dependencyLinks,
      rules: args.requiredRules.map((rule: string) => toSafeSummary(rule, 200)),
      // Display only. Never treated as authorization evidence.
      rationale: toSafeSummary(args.rationale, 600),
      requiresApprovalFrom: [...owners].sort(),
    }),
    record: {
      kind: "proposal_candidate",
      coordinationRequestId: args.coordinationRequestId,
      proposalVersion: args.proposalVersion,
      ownership: args.ownership,
      dependencyLinks: args.dependencyLinks,
      requiredRules: args.requiredRules,
    },
  };
}

/**
 * Creating a request is metadata. Granting it is a human decision, which is why
 * nothing here reads or writes an approval.
 */
async function requestContext(
  call: AuthorizedToolCall,
  raw: unknown,
): Promise<ToolExecutionResult> {
  const args = raw as Args<"relay_request_context">;

  // Forbidden paths are refused at request time, before a human is ever asked
  // to approve them. This is the `.env` denial in the demo.
  const rules = normalizeRuleSet(args.requestedPaths);
  if (!rules.ok) {
    return deny(rules.code, rules.safeReason);
  }

  return {
    kind: "artifact",
    entry: entry("permission_request", call, {
      tool: call.name,
      topic: toSafeSummary(args.topic, 200),
      purpose: toSafeSummary(args.purpose, 300),
      requestedRules: rules.value.map((rule) => rule.raw),
      persistence: args.persistence,
      willStore: ["topic", "purpose", "approved path rules", "source manifest"],
      willNotShare: [
        "private transcripts",
        "hidden reasoning",
        "environment files",
        "provider session identifiers",
      ],
    }),
    record: {
      kind: "context_request",
      topic: args.topic,
      purpose: args.purpose,
      requestedRules: rules.value.map((rule) => rule.raw),
      persistence: args.persistence,
    },
  };
}

/* ========================================================================== *
 * ContextPack — the only executor that both touches files and runs a provider
 * ========================================================================== */

export interface ContextPackDispatchContext extends DispatchContext {
  contextRequest: ValidationRequestState;
  /** Absolute path of the source Agent's workspace. */
  sourceWorkspacePath: string;
  projectId: string;
}

async function createContextPack(
  call: AuthorizedToolCall,
  raw: unknown,
  context: DispatchContext,
  ports: TelagentPorts,
): Promise<ToolExecutionResult> {
  const args = raw as Args<"relay_create_context_pack">;
  const grant = context.sourceGrant;

  if (!grant) {
    return deny(
      "PERMISSION_NOT_RESOLVED",
      "Generating a pack requires a resolved source grant from the recipient owner.",
    );
  }
  if (grant.contextRequestId !== args.contextRequestId) {
    return deny("PACK_SCOPE_MISMATCH", "The grant does not cover this context request.");
  }

  const packContext = context as ContextPackDispatchContext;
  if (!packContext.contextRequest || !packContext.sourceWorkspacePath) {
    return deny("TOOL_NOT_DISPATCHABLE", "The dispatch context is missing the source request.");
  }

  const approvedRules = normalizeRuleSet(grant.approvedPaths);
  if (!approvedRules.ok) return deny(approvedRules.code, approvedRules.safeReason);

  /**
   * The candidate arrives IN the tool call — that is Duy's
   * `createContextPackInputSchema`, and it is the right shape: the provider run
   * that produced it happened upstream, inside the isolated workspace this
   * module handed out (see `prepareApprovedContextWorkspace`).
   *
   * What still happens here, and cannot happen anywhere else: the workspace is
   * rebuilt from the approved rules so the manifest is derived from the
   * filesystem rather than from anything the model said, and the candidate is
   * checked against it. Workstream #6 keeps the try/finally either way.
   */
  const generated = await withApprovedContextWorkspace(
    {
      projectId: packContext.projectId,
      contextRequestId: grant.contextRequestId,
      sourceWorkspace: packContext.sourceWorkspacePath,
      approvedRules: approvedRules.value,
      sourceCommit: grant.sourceCommit,
    },
    ports,
    async (workspace) => workspace.manifest,
  );

  if (!generated.ok) return deny(generated.code, generated.safeReason);

  const validated = validateContextPack({
    candidate: args,
    request: { ...packContext.contextRequest, approvedRules: approvedRules.value },
    grant,
    manifest: generated.value,
    now: ports.now(),
    artifactId: "art_" + randomUUID().slice(0, 8),
  });

  if (!validated.ok) {
    ports.auditHint({
      eventType: "context_pack_rejected",
      outcome: "denied",
      actorOwnerId: call.actor.ownerId,
      actorAgentId: call.actor.agentId,
      safePayload: { code: validated.code, contextRequestId: grant.contextRequestId },
      correlationId: call.correlationId,
    });
    // The rejected candidate body is never stored.
    return deny(validated.code, validated.safeReason);
  }

  ports.auditHint({
    eventType: "context_pack_validated",
    outcome: "allowed",
    actorOwnerId: call.actor.ownerId,
    actorAgentId: call.actor.agentId,
    safePayload: {
      artifactId: validated.value.artifactId,
      sourceCount: validated.value.sources.length,
      bytes: validated.value.bytes,
      manifestDigest: generated.value.digest,
    },
    correlationId: call.correlationId,
  });

  return {
    kind: "artifact",
    entry: entry("context_pack", call, {
      tool: call.name,
      ...validated.value,
    }),
    evidence: { sourceManifestDigest: generated.value.digest },
    record: { kind: "context_pack", ...validated.value },
  };
}

/* ========================================================================== *
 * Executors — dependency and completion
 * ========================================================================== */

async function reportDependencyChange(
  call: AuthorizedToolCall,
  raw: unknown,
  context: DispatchContext,
): Promise<ToolExecutionResult> {
  const args = raw as Args<"relay_report_dependency_change">;

  const impact = detectDependencyImpact({
    change: {
      dependencyChangeId: "dep_" + randomUUID().slice(0, 8),
      intentId: context.intentId ?? "",
      ownerId: call.actor.ownerId,
      agentId: call.actor.agentId,
      interface: args.interface,
      relatedInterfaces: [],
      change: args.change,
      sourcePath: args.sourcePath,
      commit: args.commit,
    },
    activeIntents: context.activeIntents,
    agreement: context.activeAgreement,
  });

  if (!impact.ok) return deny(impact.code, impact.safeReason);

  return {
    kind: "artifact",
    entry: entry("dependency_change", call, {
      tool: call.name,
      interfaceName: args.interface,
      change: toSafeSummary(args.change, 300),
      sourcePath: impact.value.sourcePath,
      commit: args.commit,
      impactedOwnerIds: impact.value.impacted.map((item) => item.ownerId),
      unaffectedIntentCount: impact.value.unaffectedIntentIds.length,
    }),
    evidence: { commit: args.commit },
    record: { kind: "dependency_impact", ...impact.value },
  };
}

async function proposeReplan(
  call: AuthorizedToolCall,
  raw: unknown,
  context: DispatchContext,
): Promise<ToolExecutionResult> {
  const args = raw as Args<"relay_propose_replan">;

  if (!context.activeAgreement) {
    return deny("TOOL_NOT_DISPATCHABLE", "A replan requires an active ownership agreement.");
  }

  const validated = validatePlanRevision(
    {
      originalPlan: args.originalSteps,
      revisedPlan: args.revisedSteps,
      affectedFiles: args.affectedFiles,
    },
    context.activeAgreement,
    call.actor.ownerId,
  );
  if (!validated.ok) return deny(validated.code, validated.safeReason);

  return {
    kind: "artifact",
    entry: entry("plan_diff", call, {
      tool: call.name,
      dependencyChangeId: args.dependencyChangeId,
      originalPlan: args.originalSteps.map((step: string) => toSafeSummary(step, 200)),
      revisedPlan: args.revisedSteps.map((step: string) => toSafeSummary(step, 200)),
      affectedFiles: validated.value.affectedFiles,
      agreementPreserved: true,
      requiresApprovalFrom: [call.actor.ownerId],
    }),
    record: {
      kind: "plan_revision_candidate",
      dependencyChangeId: args.dependencyChangeId,
      originalPlan: args.originalSteps,
      revisedPlan: args.revisedSteps,
      affectedFiles: validated.value.affectedFiles,
    },
  };
}

async function completeTask(
  call: AuthorizedToolCall,
  raw: unknown,
  context: DispatchContext,
  ports: TelagentPorts,
): Promise<ToolExecutionResult> {
  const args = raw as Args<"relay_complete_task">;

  // Completion evidence is a list of test runs. Every one must have passed —
  // "some passed" is not a completed task.
  const testsPassed = args.tests.every((test) => test.status === "passed");
  const testSummary = args.tests
    .map((test) => test.command + ": " + test.status)
    .join("; ");
  const intentId = context.intentId ?? "";

  if (!testsPassed) {
    return deny("TOOL_NOT_DISPATCHABLE", "Completion requires passing tests.");
  }
  if (intentId.length === 0) {
    return deny("TOOL_NOT_DISPATCHABLE", "Completion requires an active intent.");
  }
  if (!context.activeAgreement) {
    return deny("TOOL_NOT_DISPATCHABLE", "Completion requires an active ownership agreement.");
  }

  const status = await statusChangedPaths(context.workspacePath, ports.git);
  if (!status.ok) {
    return deny("TOOL_NOT_DISPATCHABLE", status.safeReason);
  }

  // Ownership is checked BEFORE the checkpoint commit, so a violating diff is
  // never written into the demo history.
  const ownership = validateChangedPaths({
    changedPaths: status.value,
    agreement: context.activeAgreement,
    actorOwnerId: call.actor.ownerId,
  });

  if (!ownership.ok) {
    ports.auditHint({
      eventType: "ownership_violation",
      outcome: "denied",
      actorOwnerId: call.actor.ownerId,
      actorAgentId: call.actor.agentId,
      safePayload: { offendingPathCount: ownership.offendingPaths.length },
      correlationId: call.correlationId,
    });
    return {
      kind: "escalate",
      code: "OWNERSHIP_VIOLATION",
      safeReason: ownership.safeReason,
    };
  }

  const checkpoint = await createCheckpointCommit(
    context.workspacePath,
    "Telagent checkpoint: " + toSafeSummary(intentId, 60),
    ports.git,
  );
  if (!checkpoint.ok) return deny("TOOL_NOT_DISPATCHABLE", checkpoint.safeReason);

  const head = await currentCommit(context.workspacePath, ports.git);

  return {
    kind: "artifact",
    entry: entry("tool_result", call, {
      tool: call.name,
      intentId,
      testsPassed: true,
      testSummary: toSafeSummary(testSummary, 200),
      changedFiles: ownership.value.changedFiles,
      checkpointCommit: checkpoint.value.commit.slice(0, 7),
    }),
    evidence: {
      commit: head.ok ? head.value : checkpoint.value.commit,
      changedFiles: ownership.value.changedFiles,
    },
    record: {
      kind: "completion",
      intentId,
      changedFiles: ownership.value.changedFiles,
      checkpointCommit: checkpoint.value.commit,
      tests: args.tests,
    },
  };
}
