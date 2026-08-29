import { z } from "zod";
import {
  AGREEMENT_STATES,
  AGENT_PROVIDERS,
  CONTEXT_PACK_STATES,
  CONTEXT_REQUEST_STATES,
  COORDINATION_STATES,
  INTENT_STATES,
  OPERATION_STATES,
  PERMISSION_CLASSES,
  PLAN_REVISION_STATES,
  TELAEGENT_ERROR_CODES,
  TELAEGENT_LIMITS,
  TELAEGENT_SCHEMA_VERSION,
  TELAEGENT_TOOL_NAMES,
} from "./constants.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const branchPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\.\.\/)[A-Za-z0-9._\/-]+$/;
const commitPattern = /^[a-fA-F0-9]{7,64}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const windowsAbsolutePattern = /^[A-Za-z]:[\\/]/;

export const identifierSchema = z
  .string()
  .min(1)
  .max(TELAEGENT_LIMITS.idLength)
  .regex(idPattern, "Identifier contains unsupported characters");
export const projectIdSchema = identifierSchema;
export const branchSchema = z
  .string()
  .min(1)
  .max(TELAEGENT_LIMITS.branchLength)
  .regex(branchPattern, "Invalid branch name");
export const commitSchema = z.string().regex(commitPattern, "Invalid Git commit");
export const sha256Schema = z.string().regex(sha256Pattern, "Invalid SHA-256 digest");
export const utcTimestampSchema = z
  .string()
  .regex(utcTimestampPattern, "Expected UTC timestamp with millisecond precision")
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid UTC timestamp");

export function normalizeProtocolPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isSafeRelativePath(value: string, allowDirectoryRule = false): boolean {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    windowsAbsolutePattern.test(value)
  ) {
    return false;
  }
  const normalized = normalizeProtocolPath(value);
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "..")) {
    return false;
  }
  const wildcardIndex = normalized.indexOf("*");
  if (wildcardIndex === -1) {
    return true;
  }
  return (
    allowDirectoryRule &&
    normalized.endsWith("/**") &&
    normalized.slice(0, -3).length > 0 &&
    !normalized.slice(0, -3).includes("*")
  );
}

export const relativePathSchema = z
  .string()
  .min(1)
  .max(TELAEGENT_LIMITS.pathLength)
  .refine((value) => isSafeRelativePath(value), "Expected a safe relative file path");
export const pathRuleSchema = z
  .string()
  .min(1)
  .max(TELAEGENT_LIMITS.pathLength)
  .refine(
    (value) => isSafeRelativePath(value, true),
    "Expected an exact file or recursive directory/** rule",
  );

const shortTextSchema = z.string().trim().min(1).max(TELAEGENT_LIMITS.summaryLength);
const taskSchema = z.string().trim().min(1).max(TELAEGENT_LIMITS.taskLength);
const purposeSchema = z.string().trim().min(1).max(TELAEGENT_LIMITS.purposeLength);
const planStepsSchema = z
  .array(shortTextSchema)
  .max(TELAEGENT_LIMITS.planSteps);
const filesSchema = z.array(relativePathSchema).max(TELAEGENT_LIMITS.files);
const interfacesSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(TELAEGENT_LIMITS.interfaces);
const dependenciesSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(TELAEGENT_LIMITS.dependencies);
const blockersSchema = z.array(shortTextSchema).max(TELAEGENT_LIMITS.blockers);

export const sourceRefSchema = z.strictObject({
  path: relativePathSchema,
  commit: commitSchema,
  sha256: sha256Schema.optional(),
});
export const contextPackSourceSchema = sourceRefSchema.extend({ sha256: sha256Schema }).strict();

export const publishIntentInputSchema = z.strictObject({
  task: taskSchema,
  branch: branchSchema,
  baseCommit: commitSchema,
  plannedFiles: filesSchema,
  interfaces: interfacesSchema,
  dependencies: dependenciesSchema,
  plan: planStepsSchema,
});
export const updateProgressInputSchema = z.strictObject({
  changedFiles: filesSchema,
  progress: z.number().int().min(0).max(100),
  blockers: blockersSchema,
  verifiedAt: utcTimestampSchema,
});
export const askStatusInputSchema = z.strictObject({
  targetIntentId: identifierSchema,
  purpose: purposeSchema,
});
export const statusSnapshotSchema = z.strictObject({
  task: taskSchema,
  state: z.enum(["planning", "in_progress", "blocked", "completed", "failed"]),
  branch: branchSchema,
  changedFiles: filesSchema,
  interfaces: interfacesSchema,
  progress: z.number().int().min(0).max(100),
  blockers: blockersSchema,
  lastVerifiedAt: utcTimestampSchema,
  stale: z.boolean(),
});
const clarificationReplySchema = z.strictObject({
  summary: shortTextSchema,
  requestedClarification: shortTextSchema.optional(),
});
const acknowledgementReplySchema = z.strictObject({
  acknowledged: z.literal(true),
  summary: shortTextSchema,
});
export const relayReplyInputSchema = z.discriminatedUnion("responseKind", [
  z.strictObject({
    replyToRequestId: identifierSchema,
    responseKind: z.literal("status"),
    body: statusSnapshotSchema,
  }),
  z.strictObject({
    replyToRequestId: identifierSchema,
    responseKind: z.literal("clarification"),
    body: clarificationReplySchema,
  }),
  z.strictObject({
    replyToRequestId: identifierSchema,
    responseKind: z.literal("acknowledgement"),
    body: acknowledgementReplySchema,
  }),
]);
export const ownershipAssignmentSchema = z.strictObject({
  ownerId: identifierSchema,
  agentId: identifierSchema,
  files: filesSchema,
  interfaces: interfacesSchema,
});
export const dependencyLinkSchema = z.strictObject({
  consumerIntentId: identifierSchema,
  providerIntentId: identifierSchema,
  interface: z.string().trim().min(1).max(200),
});
export const suggestResolutionInputSchema = z.strictObject({
  coordinationRequestId: identifierSchema,
  conflictingIntentIds: z.tuple([identifierSchema, identifierSchema]),
  proposalVersion: z.number().int().positive(),
  ownership: z.array(ownershipAssignmentSchema).length(2),
  dependencyLinks: z.array(dependencyLinkSchema).max(TELAEGENT_LIMITS.dependencies),
  requiredRules: z.array(shortTextSchema).min(1).max(12),
  rationale: z.string().trim().min(1).max(TELAEGENT_LIMITS.rationaleLength),
});
export const requestContextInputSchema = z.strictObject({
  topic: shortTextSchema,
  purpose: purposeSchema,
  requestedPaths: z.array(pathRuleSchema).min(1).max(TELAEGENT_LIMITS.approvedPathRules),
  persistence: z.enum(["current-task-only", "conversation"]),
});
export const createContextPackInputSchema = z.strictObject({
  contextRequestId: identifierSchema,
  topic: shortTextSchema,
  summary: shortTextSchema,
  implementationSteps: planStepsSchema,
  validationChecklist: planStepsSchema,
  sources: z.array(contextPackSourceSchema).min(1).max(TELAEGENT_LIMITS.sourceRefs),
  taskScope: identifierSchema,
  expiresAt: utcTimestampSchema,
});
export const reportDependencyChangeInputSchema = z.strictObject({
  interface: z.string().trim().min(1).max(200),
  change: z.string().trim().min(1).max(2_000),
  sourcePath: relativePathSchema,
  commit: commitSchema,
});
export const proposeReplanInputSchema = z.strictObject({
  dependencyChangeId: identifierSchema,
  originalSteps: planStepsSchema,
  revisedSteps: planStepsSchema,
  affectedFiles: filesSchema,
});
export const testEvidenceSchema = z.strictObject({
  command: z.string().trim().min(1).max(500),
  status: z.enum(["passed", "failed"]),
  summary: shortTextSchema,
});
export const completeTaskInputSchema = z.strictObject({
  tests: z.array(testEvidenceSchema).min(1).max(12),
  changedFiles: filesSchema,
  checkpointCommit: commitSchema,
});
export const humanDecisionOptionSchema = z.strictObject({
  id: identifierSchema,
  label: z.string().trim().min(1).max(100),
  safeDescription: z.string().trim().min(1).max(500),
});
export const requestHumanDecisionInputSchema = z.strictObject({
  reasonCode: z.enum([
    "SOURCE_ACCESS_REQUIRED",
    "DUAL_COMMITMENT_REQUIRED",
    "AFFECTED_PLAN_APPROVAL_REQUIRED",
    "STALE_STATUS",
    "AMBIGUOUS_RESOLUTION",
    "EXCHANGE_LIMIT_REACHED",
  ]),
  reason: shortTextSchema,
  options: z.array(humanDecisionOptionSchema).min(2).max(4),
});

export const payloadSchemas = {
  relay_publish_intent: publishIntentInputSchema,
  relay_update_progress: updateProgressInputSchema,
  relay_ask_status: askStatusInputSchema,
  relay_reply: relayReplyInputSchema,
  relay_suggest_resolution: suggestResolutionInputSchema,
  relay_request_context: requestContextInputSchema,
  relay_create_context_pack: createContextPackInputSchema,
  relay_report_dependency_change: reportDependencyChangeInputSchema,
  relay_propose_replan: proposeReplanInputSchema,
  relay_complete_task: completeTaskInputSchema,
  relay_request_human_decision: requestHumanDecisionInputSchema,
} as const;

const senderSchema = z.strictObject({
  ownerId: identifierSchema,
  agentId: identifierSchema,
  provider: z.enum(AGENT_PROVIDERS),
});
const recipientSchema = z.strictObject({
  ownerId: identifierSchema,
  agentId: identifierSchema,
});
const deliverySchema = z.strictObject({
  mode: z.literal("async"),
  exchangeNumber: z
    .number()
    .int()
    .min(1)
    .max(TELAEGENT_LIMITS.maxExchangeNumber),
  createdAt: utcTimestampSchema,
  expiresAt: utcTimestampSchema,
  replyToRequestId: identifierSchema.optional(),
});
const evidenceSchema = z.strictObject({
  branch: branchSchema,
  baseCommit: commitSchema,
  sourceRefs: z.array(sourceRefSchema).max(TELAEGENT_LIMITS.sourceRefs).optional(),
});
const envelopeCommon = {
  schemaVersion: z.literal(TELAEGENT_SCHEMA_VERSION),
  requestId: identifierSchema,
  correlationId: identifierSchema,
  idempotencyKey: identifierSchema,
  projectId: projectIdSchema,
  conversationId: identifierSchema,
  intentId: identifierSchema.optional(),
  sender: senderSchema,
  recipient: recipientSchema.optional(),
  delivery: deliverySchema,
  evidence: evidenceSchema,
};

const envelopeVariants = [
  z.strictObject({ ...envelopeCommon, operation: z.literal("relay_publish_intent"), payload: publishIntentInputSchema }),
  z.strictObject({ ...envelopeCommon, operation: z.literal("relay_update_progress"), payload: updateProgressInputSchema }),
  z.strictObject({ ...envelopeCommon, operation: z.literal("relay_ask_status"), payload: askStatusInputSchema }),
  z.strictObject({ ...envelopeCommon, operation: z.literal("relay_reply"), payload: relayReplyInputSchema }),
  z.strictObject({ ...envelopeCommon, operation: z.literal("relay_suggest_resolution"), payload: suggestResolutionInputSchema }),
  z.strictObject({ ...envelopeCommon, operation: z.literal("relay_request_context"), payload: requestContextInputSchema }),
  z.strictObject({ ...envelopeCommon, operation: z.literal("relay_create_context_pack"), payload: createContextPackInputSchema }),
  z.strictObject({ ...envelopeCommon, operation: z.literal("relay_report_dependency_change"), payload: reportDependencyChangeInputSchema }),
  z.strictObject({ ...envelopeCommon, operation: z.literal("relay_propose_replan"), payload: proposeReplanInputSchema }),
  z.strictObject({ ...envelopeCommon, operation: z.literal("relay_complete_task"), payload: completeTaskInputSchema }),
  z.strictObject({ ...envelopeCommon, operation: z.literal("relay_request_human_decision"), payload: requestHumanDecisionInputSchema }),
] as const;

const recipientRequiredOperations = new Set([
  "relay_ask_status",
  "relay_reply",
  "relay_suggest_resolution",
  "relay_request_context",
  "relay_create_context_pack",
  "relay_propose_replan",
]);

export const telaegentEnvelopeSchema = z
  .discriminatedUnion("operation", envelopeVariants)
  .superRefine((value, context) => {
    if (Date.parse(value.delivery.expiresAt) <= Date.parse(value.delivery.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["delivery", "expiresAt"],
        message: "expiresAt must be after createdAt",
      });
    }
    if (recipientRequiredOperations.has(value.operation) && !value.recipient) {
      context.addIssue({
        code: "custom",
        path: ["recipient"],
        message: "recipient is required for this cross-Agent operation",
      });
    }
    if (value.recipient?.agentId === value.sender.agentId) {
      context.addIssue({
        code: "custom",
        path: ["recipient", "agentId"],
        message: "recipient Agent must differ from sender Agent",
      });
    }
    if (value.operation === "relay_reply") {
      const deliveryReplyId = value.delivery.replyToRequestId;
      if (!deliveryReplyId || deliveryReplyId !== value.payload.replyToRequestId) {
        context.addIssue({
          code: "custom",
          path: ["delivery", "replyToRequestId"],
          message: "reply identifiers must be present and match",
        });
      }
    }
  });

const action = <TName extends keyof typeof payloadSchemas>(name: TName) =>
  z.strictObject({ name: z.literal(name), arguments: payloadSchemas[name] });

export const telaegentToolActionSchema = z.discriminatedUnion("name", [
  action("relay_publish_intent"),
  action("relay_update_progress"),
  action("relay_ask_status"),
  action("relay_reply"),
  action("relay_suggest_resolution"),
  action("relay_request_context"),
  action("relay_create_context_pack"),
  action("relay_report_dependency_change"),
  action("relay_propose_replan"),
  action("relay_complete_task"),
  action("relay_request_human_decision"),
]);

const agentStep = (nextAction: z.ZodType) =>
  z.strictObject({
    publicSummary: z.string().trim().min(1).max(TELAEGENT_LIMITS.summaryLength),
    nextAction: nextAction.nullable(),
    taskState: z.enum(["working", "blocked", "completed"]),
  });
const unionOfActions = (...names: (keyof typeof payloadSchemas)[]) =>
  z.union(names.map((name) => action(name)) as [ReturnType<typeof action>, ...ReturnType<typeof action>[]]);

export const planIntentOutputSchema = agentStep(
  unionOfActions("relay_publish_intent", "relay_request_human_decision"),
);
export const statusOutputSchema = agentStep(
  unionOfActions("relay_update_progress", "relay_reply", "relay_request_human_decision"),
);
export const resolutionOutputSchema = agentStep(
  unionOfActions("relay_suggest_resolution", "relay_request_human_decision"),
);
export const implementationResultOutputSchema = agentStep(
  unionOfActions(
    "relay_update_progress",
    "relay_request_context",
    "relay_report_dependency_change",
    "relay_complete_task",
    "relay_request_human_decision",
  ),
);
export const contextRequestOutputSchema = agentStep(
  unionOfActions("relay_request_context", "relay_request_human_decision"),
);
export const contextPackOutputSchema = agentStep(
  unionOfActions("relay_create_context_pack", "relay_reply", "relay_request_human_decision"),
);
export const dependencyChangeOutputSchema = agentStep(
  unionOfActions("relay_report_dependency_change", "relay_request_human_decision"),
);
export const planRevisionOutputSchema = agentStep(
  unionOfActions("relay_propose_replan", "relay_request_human_decision"),
);

export const outputSchemasByName = {
  "plan-intent.schema.json": planIntentOutputSchema,
  "status.schema.json": statusOutputSchema,
  "resolution.schema.json": resolutionOutputSchema,
  "implementation-result.schema.json": implementationResultOutputSchema,
  "context-request.schema.json": contextRequestOutputSchema,
  "context-pack.schema.json": contextPackOutputSchema,
  "dependency-change.schema.json": dependencyChangeOutputSchema,
  "plan-revision.schema.json": planRevisionOutputSchema,
} as const;

const conflictSignalSchema = z.strictObject({
  type: z.enum(["changed_file", "planned_changed", "interface", "planned_file", "module", "base_commit"]),
  value: z.string().min(1).max(512),
  score: z.number().int().min(1).max(5),
});
export const conflictAssessmentSchema = z.strictObject({
  score: z.number().int().nonnegative(),
  level: z.enum(["none", "suggested", "blocking"]),
  signals: z.array(conflictSignalSchema).max(100),
});
export const projectSchema = z.strictObject({
  projectId: projectIdSchema,
  name: z.string().trim().min(1).max(100),
  agentIds: z.array(identifierSchema).min(1).max(20),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
});
export const ownerSchema = z.strictObject({ ownerId: identifierSchema, displayName: z.string().trim().min(1).max(100) });
export const agentBindingSchema = z.strictObject({
  agentId: identifierSchema,
  ownerId: identifierSchema,
  projectId: projectIdSchema,
  provider: z.enum(AGENT_PROVIDERS),
  workspacePath: z.string().min(1).max(1_024),
  branch: branchSchema,
  baseCommit: commitSchema,
  providerSessionId: identifierSchema.optional(),
  activeIntentId: identifierSchema.optional(),
});
export const coordinationConversationSchema = z.strictObject({
  conversationId: identifierSchema,
  projectId: projectIdSchema,
  participantAgentIds: z.array(identifierSchema).min(2).max(2),
  state: z.enum(["active", "completed"]),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
});
export const conversationActorSchema = z.strictObject({
  type: z.enum(["human", "agent", "system"]),
  id: identifierSchema,
  ownerId: identifierSchema.optional(),
});

const safeJsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(10_000),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(safeJsonValueSchema).max(100),
    z.record(z.string().min(1).max(100), safeJsonValueSchema),
  ]),
);
export const safeJsonObjectSchema = z.record(z.string().min(1).max(100), safeJsonValueSchema);

const entryCommon = {
  entryId: identifierSchema,
  conversationId: identifierSchema,
  actor: conversationActorSchema,
  operationId: identifierSchema.optional(),
  correlationId: identifierSchema,
  createdAt: utcTimestampSchema,
};
export const conversationEntrySchema = z.discriminatedUnion("type", [
  z.strictObject({ ...entryCommon, type: z.literal("human_message"), payload: z.strictObject({ content: taskSchema }) }),
  z.strictObject({ ...entryCommon, type: z.literal("agent_summary"), payload: z.strictObject({ summary: shortTextSchema, taskState: z.enum(["working", "blocked", "completed"]) }) }),
  z.strictObject({ ...entryCommon, type: z.literal("tool_call"), payload: z.strictObject({ action: telaegentToolActionSchema }) }),
  z.strictObject({ ...entryCommon, type: z.literal("tool_result"), payload: z.strictObject({ toolName: z.enum(TELAEGENT_TOOL_NAMES), outcome: z.enum(["completed", "denied", "failed"]), safeSummary: shortTextSchema }) }),
  z.strictObject({ ...entryCommon, type: z.literal("permission_request"), payload: z.strictObject({ permissionClass: z.enum(["RECIPIENT_SOURCE_APPROVAL", "DUAL_OWNER_COMMITMENT", "AFFECTED_OWNER_APPROVAL"]), approverOwnerIds: z.array(identifierSchema).min(1).max(2), purpose: purposeSchema, expiresAt: utcTimestampSchema }) }),
  z.strictObject({ ...entryCommon, type: z.literal("permission_decision"), payload: z.strictObject({ ownerId: identifierSchema, decision: z.enum(["approve", "reject"]), targetVersion: z.number().int().positive() }) }),
  z.strictObject({ ...entryCommon, type: z.literal("context_pack"), payload: z.strictObject({ artifactId: identifierSchema, topic: shortTextSchema, summary: shortTextSchema, expiresAt: utcTimestampSchema }) }),
  z.strictObject({ ...entryCommon, type: z.literal("dependency_change"), payload: reportDependencyChangeInputSchema.extend({ dependencyChangeId: identifierSchema }).strict() }),
  z.strictObject({ ...entryCommon, type: z.literal("plan_diff"), payload: proposeReplanInputSchema.extend({ revisionId: identifierSchema }).strict() }),
  z.strictObject({ ...entryCommon, type: z.literal("system_event"), payload: z.strictObject({ eventType: identifierSchema, safeSummary: shortTextSchema }) }),
  z.strictObject({ ...entryCommon, type: z.literal("error"), payload: z.strictObject({ code: z.enum(TELAEGENT_ERROR_CODES), message: shortTextSchema, auditEventId: identifierSchema.optional() }) }),
]);

export const intentSchema = z.strictObject({
  intentId: identifierSchema,
  projectId: projectIdSchema,
  conversationId: identifierSchema,
  ownerId: identifierSchema,
  agentId: identifierSchema,
  task: taskSchema,
  branch: branchSchema,
  baseCommit: commitSchema,
  plannedFiles: filesSchema,
  changedFiles: filesSchema,
  interfaces: interfacesSchema,
  dependencies: dependenciesSchema,
  plan: planStepsSchema,
  progress: z.number().int().min(0).max(100),
  blockers: blockersSchema,
  lastVerifiedAt: utcTimestampSchema.optional(),
  planningRunId: identifierSchema.optional(),
  implementationRunId: identifierSchema.optional(),
  status: z.enum(INTENT_STATES),
  version: z.number().int().positive(),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
});
export const coordinationRequestSchema = z.strictObject({
  requestId: identifierSchema,
  projectId: projectIdSchema,
  conversationId: identifierSchema,
  participantIntentIds: z.tuple([identifierSchema, identifierSchema]),
  participantAgentIds: z.tuple([identifierSchema, identifierSchema]),
  conflict: conflictAssessmentSchema,
  statusSnapshot: statusSnapshotSchema.optional(),
  exchangeCount: z.number().int().min(0).max(TELAEGENT_LIMITS.maxExchangeNumber),
  proposalId: identifierSchema.optional(),
  state: z.enum(COORDINATION_STATES),
  version: z.number().int().positive(),
  expiresAt: utcTimestampSchema,
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
});
export const agreementApprovalSchema = z.strictObject({
  ownerId: identifierSchema,
  decision: z.enum(["approve", "reject"]),
  proposalVersion: z.number().int().positive(),
  decidedAt: utcTimestampSchema,
});
export const agreementSchema = z.strictObject({
  agreementId: identifierSchema,
  projectId: projectIdSchema,
  conversationId: identifierSchema,
  coordinationRequestId: identifierSchema,
  participantOwnerIds: z.tuple([identifierSchema, identifierSchema]),
  proposalVersion: z.number().int().positive(),
  ownership: z.array(ownershipAssignmentSchema).length(2),
  dependencyLinks: z.array(dependencyLinkSchema).max(TELAEGENT_LIMITS.dependencies),
  requiredRules: z.array(shortTextSchema).min(1).max(12),
  rationale: z.string().trim().min(1).max(TELAEGENT_LIMITS.rationaleLength),
  approvals: z.array(agreementApprovalSchema).max(2),
  state: z.enum(AGREEMENT_STATES),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
});
export const contextDecisionSchema = z.strictObject({
  ownerId: identifierSchema,
  decision: z.enum(["approve", "deny"]),
  targetVersion: z.number().int().positive(),
  approvedPaths: z.array(pathRuleSchema).max(TELAEGENT_LIMITS.approvedPathRules),
  decidedAt: utcTimestampSchema,
});
export const contextRequestSchema = z.strictObject({
  requestId: identifierSchema,
  projectId: projectIdSchema,
  conversationId: identifierSchema,
  senderOwnerId: identifierSchema,
  senderAgentId: identifierSchema,
  recipientOwnerId: identifierSchema,
  recipientAgentId: identifierSchema,
  topic: shortTextSchema,
  purpose: purposeSchema,
  requestedPaths: z.array(pathRuleSchema).min(1).max(TELAEGENT_LIMITS.approvedPathRules),
  approvedPaths: z.array(pathRuleSchema).max(TELAEGENT_LIMITS.approvedPathRules),
  persistence: z.enum(["current-task-only", "conversation"]),
  decision: contextDecisionSchema.optional(),
  state: z.enum(CONTEXT_REQUEST_STATES),
  version: z.number().int().positive(),
  expiresAt: utcTimestampSchema,
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
});
export const contextPackSchema = z.strictObject({
  artifactId: identifierSchema,
  requestId: identifierSchema,
  projectId: projectIdSchema,
  topic: shortTextSchema,
  summary: shortTextSchema,
  implementationSteps: planStepsSchema,
  validationChecklist: planStepsSchema,
  sources: z.array(contextPackSourceSchema).min(1).max(TELAEGENT_LIMITS.sourceRefs),
  sharedBy: identifierSchema,
  taskScope: identifierSchema,
  expiresAt: utcTimestampSchema,
  state: z.enum(CONTEXT_PACK_STATES),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
});
export const dependencyChangeSchema = z.strictObject({
  dependencyChangeId: identifierSchema,
  projectId: projectIdSchema,
  conversationId: identifierSchema,
  intentId: identifierSchema,
  agentId: identifierSchema,
  interface: z.string().trim().min(1).max(200),
  change: z.string().trim().min(1).max(2_000),
  sourcePath: relativePathSchema,
  commit: commitSchema,
  affectedIntentIds: z.array(identifierSchema).max(20),
  createdAt: utcTimestampSchema,
});
export const planRevisionSchema = z.strictObject({
  revisionId: identifierSchema,
  projectId: projectIdSchema,
  conversationId: identifierSchema,
  intentId: identifierSchema,
  ownerId: identifierSchema,
  dependencyChangeId: identifierSchema,
  originalSteps: planStepsSchema,
  revisedSteps: planStepsSchema,
  affectedFiles: filesSchema,
  validationResult: z.enum(["pending", "valid", "invalid"]),
  ownerDecision: z.enum(["approve", "reject"]).optional(),
  state: z.enum(PLAN_REVISION_STATES),
  version: z.number().int().positive(),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
});
export const safeOperationErrorSchema = z.strictObject({
  code: z.enum(TELAEGENT_ERROR_CODES),
  message: shortTextSchema,
  safeDetails: safeJsonObjectSchema.optional(),
  auditEventId: identifierSchema.optional(),
});
export const operationSchema = z.strictObject({
  operationId: identifierSchema,
  type: z.union([z.enum(TELAEGENT_TOOL_NAMES), z.enum(["agent_run", "workflow"])]),
  projectId: projectIdSchema,
  conversationId: identifierSchema,
  requestId: identifierSchema,
  correlationId: identifierSchema,
  agentId: identifierSchema.optional(),
  runId: identifierSchema.optional(),
  intentId: identifierSchema.optional(),
  state: z.enum(OPERATION_STATES),
  result: safeJsonValueSchema.optional(),
  error: safeOperationErrorSchema.optional(),
  expiresAt: utcTimestampSchema.optional(),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
  completedAt: utcTimestampSchema.optional(),
});
export const auditEventSchema = z.strictObject({
  eventId: identifierSchema,
  sequence: z.number().int().nonnegative(),
  projectId: projectIdSchema,
  conversationId: identifierSchema,
  correlationId: identifierSchema,
  actor: conversationActorSchema,
  eventType: identifierSchema,
  outcome: z.enum(["success", "denied", "failed", "pending"]),
  payload: safeJsonObjectSchema,
  timestamp: utcTimestampSchema,
});
export const idempotencyRecordSchema = z.strictObject({
  projectId: projectIdSchema,
  senderAgentId: identifierSchema,
  operation: z.enum(TELAEGENT_TOOL_NAMES),
  idempotencyKey: identifierSchema,
  requestFingerprint: sha256Schema,
  requestId: identifierSchema,
  operationId: identifierSchema,
  expiresAt: utcTimestampSchema,
  createdAt: utcTimestampSchema,
});
export const telaegentDatabaseSchema = z.strictObject({
  projects: z.array(projectSchema),
  owners: z.array(ownerSchema),
  agentBindings: z.array(agentBindingSchema),
  conversations: z.array(coordinationConversationSchema),
  conversationEntries: z.array(conversationEntrySchema),
  intents: z.array(intentSchema),
  coordinationRequests: z.array(coordinationRequestSchema),
  agreements: z.array(agreementSchema),
  contextRequests: z.array(contextRequestSchema),
  contextPacks: z.array(contextPackSchema),
  dependencyChanges: z.array(dependencyChangeSchema),
  planRevisions: z.array(planRevisionSchema),
  operations: z.array(operationSchema),
  events: z.array(auditEventSchema),
  idempotencyRecords: z.array(idempotencyRecordSchema),
});

export const agreementDecisionInputSchema = z.strictObject({
  ownerId: identifierSchema,
  decision: z.enum(["approve", "reject"]),
  targetVersion: z.number().int().positive(),
});
export const contextRequestDecisionInputSchema = z
  .strictObject({
    ownerId: identifierSchema,
    decision: z.enum(["approve", "deny"]),
    targetVersion: z.number().int().positive(),
    approvedPaths: z.array(pathRuleSchema).max(TELAEGENT_LIMITS.approvedPathRules),
  })
  .superRefine((value, context) => {
    if (value.decision === "approve" && value.approvedPaths.length === 0) {
      context.addIssue({ code: "custom", path: ["approvedPaths"], message: "Approval requires at least one path" });
    }
    if (value.decision === "deny" && value.approvedPaths.length > 0) {
      context.addIssue({ code: "custom", path: ["approvedPaths"], message: "Denied requests cannot grant paths" });
    }
  });
export const planRevisionDecisionInputSchema = z.strictObject({
  ownerId: identifierSchema,
  decision: z.enum(["approve", "reject"]),
  targetVersion: z.number().int().positive(),
});
export const operationAcknowledgementSchema = z.strictObject({
  operationId: identifierSchema,
  requestId: identifierSchema,
  correlationId: identifierSchema,
  state: z.enum(OPERATION_STATES),
  pollUrl: z.string().regex(/^\/api\/telaegent\/operations\/[A-Za-z0-9._:-]+$/),
});
export const telaegentErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(TELAEGENT_ERROR_CODES),
    message: shortTextSchema,
    safeDetails: safeJsonObjectSchema.optional(),
    correlationId: identifierSchema,
    auditEventId: identifierSchema.optional(),
  }),
});

export const permissionDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("allow"), permissionClass: z.literal("AUTO_METADATA"), safeScope: safeJsonValueSchema }),
  z.strictObject({ kind: z.literal("ask_human"), permissionClass: z.enum(["RECIPIENT_SOURCE_APPROVAL", "DUAL_OWNER_COMMITMENT", "AFFECTED_OWNER_APPROVAL"]), approverOwnerIds: z.array(identifierSchema).min(1).max(2), expiresAt: utcTimestampSchema, safeScope: safeJsonValueSchema }),
  z.strictObject({ kind: z.literal("deny"), permissionClass: z.literal("ALWAYS_DENY"), code: identifierSchema, safeReason: shortTextSchema }),
]);

export const allowedActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("continue_intent"), intentId: identifierSchema, expectedVersion: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("complete_intent"), intentId: identifierSchema, expectedVersion: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("report_dependency_change"), intentId: identifierSchema, expectedVersion: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("request_status"), coordinationRequestId: identifierSchema, expectedVersion: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("request_proposal"), coordinationRequestId: identifierSchema, expectedVersion: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("decide_agreement"), agreementId: identifierSchema, expectedVersion: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("decide_context_request"), requestId: identifierSchema, expectedVersion: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("generate_context_pack"), requestId: identifierSchema, expectedVersion: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("request_replan"), revisionId: identifierSchema, expectedVersion: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("decide_plan_revision"), revisionId: identifierSchema, expectedVersion: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("cancel_operation"), operationId: identifierSchema }),
]);

export const projectSnapshotSchema = z.strictObject({
  project: projectSchema,
  owners: z.array(ownerSchema),
  agentBindings: z.array(agentBindingSchema),
  conversation: coordinationConversationSchema,
  conversationEntries: z.array(conversationEntrySchema),
  intents: z.array(intentSchema),
  coordinationRequest: coordinationRequestSchema.nullable(),
  agreement: agreementSchema.nullable(),
  contextRequest: contextRequestSchema.nullable(),
  contextPack: contextPackSchema.nullable(),
  dependencyChange: dependencyChangeSchema.nullable(),
  planRevision: planRevisionSchema.nullable(),
  activeOperations: z.array(operationSchema),
  auditEvents: z.array(auditEventSchema),
  allowedActions: z.array(allowedActionSchema),
});

export const versionedMutationInputSchema = z.strictObject({
  ownerId: identifierSchema,
  correlationId: identifierSchema,
  idempotencyKey: identifierSchema,
  targetVersion: z.number().int().positive(),
});
export const conversationMessageInputSchema = z.strictObject({
  ownerId: identifierSchema,
  agentId: identifierSchema,
  content: z.string().trim().min(1).max(50_000),
  correlationId: identifierSchema,
  idempotencyKey: identifierSchema,
});
export const completeIntentHttpInputSchema = versionedMutationInputSchema
  .extend({ completion: completeTaskInputSchema })
  .strict();
export const agreementDecisionHttpInputSchema = agreementDecisionInputSchema
  .extend({ correlationId: identifierSchema, idempotencyKey: identifierSchema })
  .strict();
export const contextRequestHttpInputSchema = z
  .strictObject({
    senderOwnerId: identifierSchema,
    senderAgentId: identifierSchema,
    recipientOwnerId: identifierSchema,
    recipientAgentId: identifierSchema,
    topic: shortTextSchema,
    purpose: purposeSchema,
    requestedPaths: z.array(pathRuleSchema).min(1).max(TELAEGENT_LIMITS.approvedPathRules),
    persistence: z.enum(["current-task-only", "conversation"]),
    expiresAt: utcTimestampSchema,
    correlationId: identifierSchema,
    idempotencyKey: identifierSchema,
  })
  .refine((value) => value.senderAgentId !== value.recipientAgentId, {
    path: ["recipientAgentId"],
    message: "recipient Agent must differ from sender Agent",
  });
export const contextRequestDecisionHttpInputSchema = z
  .strictObject({
    ownerId: identifierSchema,
    decision: z.enum(["approve", "deny"]),
    targetVersion: z.number().int().positive(),
    approvedPaths: z.array(pathRuleSchema).max(TELAEGENT_LIMITS.approvedPathRules),
    correlationId: identifierSchema,
    idempotencyKey: identifierSchema,
  })
  .superRefine((value, context) => {
    if (value.decision === "approve" && value.approvedPaths.length === 0) {
      context.addIssue({ code: "custom", path: ["approvedPaths"], message: "Approval requires at least one path" });
    }
    if (value.decision === "deny" && value.approvedPaths.length > 0) {
      context.addIssue({ code: "custom", path: ["approvedPaths"], message: "Denied requests cannot grant paths" });
    }
  });
export const dependencyChangeHttpInputSchema = versionedMutationInputSchema
  .extend({ change: reportDependencyChangeInputSchema })
  .strict();
export const planRevisionDecisionHttpInputSchema = planRevisionDecisionInputSchema
  .extend({ correlationId: identifierSchema, idempotencyKey: identifierSchema })
  .strict();
export const cancelOperationInputSchema = z.strictObject({
  ownerId: identifierSchema,
  correlationId: identifierSchema,
  targetVersion: z.number().int().positive(),
});
export const resetDemoInputSchema = z.strictObject({ confirmProjectId: z.literal("phoenix") });

export const telaegentHttpBodySchemas = {
  conversationMessage: conversationMessageInputSchema,
  continueIntent: versionedMutationInputSchema,
  completeIntent: completeIntentHttpInputSchema,
  requestCoordinationStatus: versionedMutationInputSchema,
  requestCoordinationProposal: versionedMutationInputSchema,
  decideAgreement: agreementDecisionHttpInputSchema,
  createContextRequest: contextRequestHttpInputSchema,
  decideContextRequest: contextRequestDecisionHttpInputSchema,
  generateContextPack: versionedMutationInputSchema,
  publishDependencyChange: dependencyChangeHttpInputSchema,
  requestReplan: versionedMutationInputSchema,
  decidePlanRevision: planRevisionDecisionHttpInputSchema,
  cancelOperation: cancelOperationInputSchema,
  resetDemo: resetDemoInputSchema,
} as const;
