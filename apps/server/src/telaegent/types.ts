import type { AgentProvider } from "../types.js";
import {
  AGREEMENT_STATES,
  CONTEXT_PACK_STATES,
  CONTEXT_REQUEST_STATES,
  COORDINATION_STATES,
  INTENT_STATES,
  OPERATION_STATES,
  PERMISSION_CLASSES,
  PLAN_REVISION_STATES,
  TELAEGENT_ERROR_CODES,
  TELAEGENT_TOOL_NAMES,
} from "./constants.js";

export type TelaegentToolName = (typeof TELAEGENT_TOOL_NAMES)[number];
export type PermissionClass = (typeof PERMISSION_CLASSES)[number];
export type OperationState = (typeof OPERATION_STATES)[number];
export type CoordinationState = (typeof COORDINATION_STATES)[number];
export type ContextRequestState = (typeof CONTEXT_REQUEST_STATES)[number];
export type PlanRevisionState = (typeof PLAN_REVISION_STATES)[number];
export type IntentState = (typeof INTENT_STATES)[number];
export type AgreementState = (typeof AGREEMENT_STATES)[number];
export type ContextPackState = (typeof CONTEXT_PACK_STATES)[number];
export type TelaegentErrorCode = (typeof TELAEGENT_ERROR_CODES)[number];
export type AgentTaskState = "working" | "blocked" | "completed";
export type UtcTimestamp = string;

export type SafeJsonPrimitive = string | number | boolean | null;
export type SafeJsonValue =
  | SafeJsonPrimitive
  | SafeJsonValue[]
  | { [key: string]: SafeJsonValue };
export type SafeJsonObject = { [key: string]: SafeJsonValue };

export interface SourceRef {
  path: string;
  commit: string;
  sha256?: string | undefined;
}

export interface PublishIntentInput {
  task: string;
  branch: string;
  baseCommit: string;
  plannedFiles: string[];
  interfaces: string[];
  dependencies: string[];
  plan: string[];
}

export interface UpdateProgressInput {
  changedFiles: string[];
  progress: number;
  blockers: string[];
  verifiedAt: UtcTimestamp;
}

export interface AskStatusInput {
  targetIntentId: string;
  purpose: string;
}

export interface StatusSnapshot {
  task: string;
  state: "planning" | "in_progress" | "blocked" | "completed" | "failed";
  branch: string;
  changedFiles: string[];
  interfaces: string[];
  progress: number;
  blockers: string[];
  lastVerifiedAt: UtcTimestamp;
  stale: boolean;
}

export interface ClarificationReplyBody {
  summary: string;
  requestedClarification?: string | undefined;
}

export interface AcknowledgementReplyBody {
  acknowledged: true;
  summary: string;
}

export type RelayReplyInput =
  | {
      replyToRequestId: string;
      responseKind: "status";
      body: StatusSnapshot;
    }
  | {
      replyToRequestId: string;
      responseKind: "clarification";
      body: ClarificationReplyBody;
    }
  | {
      replyToRequestId: string;
      responseKind: "acknowledgement";
      body: AcknowledgementReplyBody;
    };

export interface OwnershipAssignment {
  ownerId: string;
  agentId: string;
  files: string[];
  interfaces: string[];
}

export interface DependencyLink {
  consumerIntentId: string;
  providerIntentId: string;
  interface: string;
}

export interface ResolutionProposal {
  proposalVersion: number;
  ownership: OwnershipAssignment[];
  dependencyLinks: DependencyLink[];
  requiredRules: string[];
  rationale: string;
}

export interface SuggestResolutionInput extends ResolutionProposal {
  coordinationRequestId: string;
  conflictingIntentIds: [string, string];
}

export interface RequestContextInput {
  topic: string;
  purpose: string;
  requestedPaths: string[];
  persistence: "current-task-only" | "conversation";
}

export interface ContextPackSource extends SourceRef {
  sha256: string;
}

export interface CreateContextPackInput {
  contextRequestId: string;
  topic: string;
  summary: string;
  implementationSteps: string[];
  validationChecklist: string[];
  sources: ContextPackSource[];
  taskScope: string;
  expiresAt: UtcTimestamp;
}

export interface ReportDependencyChangeInput {
  interface: string;
  change: string;
  sourcePath: string;
  commit: string;
}

export interface ProposeReplanInput {
  dependencyChangeId: string;
  originalSteps: string[];
  revisedSteps: string[];
  affectedFiles: string[];
}

export interface TestEvidence {
  command: string;
  status: "passed" | "failed";
  summary: string;
}

export interface CompleteTaskInput {
  tests: TestEvidence[];
  changedFiles: string[];
  checkpointCommit: string;
}

export type HumanDecisionReasonCode =
  | "SOURCE_ACCESS_REQUIRED"
  | "DUAL_COMMITMENT_REQUIRED"
  | "AFFECTED_PLAN_APPROVAL_REQUIRED"
  | "STALE_STATUS"
  | "AMBIGUOUS_RESOLUTION"
  | "EXCHANGE_LIMIT_REACHED";

export interface HumanDecisionOption {
  id: string;
  label: string;
  safeDescription: string;
}

export interface RequestHumanDecisionInput {
  reasonCode: HumanDecisionReasonCode;
  reason: string;
  options: HumanDecisionOption[];
}

export interface PayloadByOperation {
  relay_publish_intent: PublishIntentInput;
  relay_update_progress: UpdateProgressInput;
  relay_ask_status: AskStatusInput;
  relay_reply: RelayReplyInput;
  relay_suggest_resolution: SuggestResolutionInput;
  relay_request_context: RequestContextInput;
  relay_create_context_pack: CreateContextPackInput;
  relay_report_dependency_change: ReportDependencyChangeInput;
  relay_propose_replan: ProposeReplanInput;
  relay_complete_task: CompleteTaskInput;
  relay_request_human_decision: RequestHumanDecisionInput;
}

export interface TelaegentEnvelopeBase<
  TOperation extends TelaegentToolName,
  TPayload,
> {
  schemaVersion: "telaegent.v1";
  requestId: string;
  correlationId: string;
  idempotencyKey: string;
  projectId: string;
  conversationId: string;
  intentId?: string | undefined;
  sender: {
    ownerId: string;
    agentId: string;
    provider: AgentProvider;
  };
  recipient?:
    | {
        ownerId: string;
        agentId: string;
      }
    | undefined;
  operation: TOperation;
  payload: TPayload;
  delivery: {
    mode: "async";
    exchangeNumber: 1 | 2 | 3;
    createdAt: UtcTimestamp;
    expiresAt: UtcTimestamp;
    replyToRequestId?: string | undefined;
  };
  evidence: {
    branch: string;
    baseCommit: string;
    sourceRefs?: SourceRef[] | undefined;
  };
}

/** Generic envelope spelling retained for consumers that know their payload type. */
export type TelaegentEnvelope<
  TPayload,
  TOperation extends TelaegentToolName = TelaegentToolName,
> = TelaegentEnvelopeBase<TOperation, TPayload>;

/** Public request union. `operation` always determines the exact payload schema. */
export type TelaegentRequest = {
  [TOperation in TelaegentToolName]: TelaegentEnvelopeBase<
    TOperation,
    PayloadByOperation[TOperation]
  >;
}[TelaegentToolName];

export type TelaegentToolAction = {
  [TOperation in TelaegentToolName]: {
    name: TOperation;
    arguments: PayloadByOperation[TOperation];
  };
}[TelaegentToolName];

export interface AgentStep<TAction extends TelaegentToolAction = TelaegentToolAction> {
  publicSummary: string;
  nextAction: TAction | null;
  taskState: AgentTaskState;
}

type ActionNamed<TName extends TelaegentToolName> = Extract<
  TelaegentToolAction,
  { name: TName }
>;

export type PlanIntentOutput = AgentStep<
  ActionNamed<"relay_publish_intent" | "relay_request_human_decision">
>;
export type StatusOutput = AgentStep<
  ActionNamed<"relay_update_progress" | "relay_reply" | "relay_request_human_decision">
>;
export type ResolutionOutput = AgentStep<
  ActionNamed<"relay_suggest_resolution" | "relay_request_human_decision">
>;
export type ImplementationResultOutput = AgentStep<
  ActionNamed<
    | "relay_update_progress"
    | "relay_request_context"
    | "relay_report_dependency_change"
    | "relay_complete_task"
    | "relay_request_human_decision"
  >
>;
export type ContextRequestOutput = AgentStep<
  ActionNamed<"relay_request_context" | "relay_request_human_decision">
>;
export type ContextPackOutput = AgentStep<
  ActionNamed<"relay_create_context_pack" | "relay_reply" | "relay_request_human_decision">
>;
export type DependencyChangeOutput = AgentStep<
  ActionNamed<"relay_report_dependency_change" | "relay_request_human_decision">
>;
export type PlanRevisionOutput = AgentStep<
  ActionNamed<"relay_propose_replan" | "relay_request_human_decision">
>;

export interface Project {
  projectId: string;
  name: string;
  agentIds: string[];
  createdAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
}

export interface Owner {
  ownerId: string;
  displayName: string;
}

export interface AgentBinding {
  agentId: string;
  ownerId: string;
  projectId: string;
  provider: AgentProvider;
  workspacePath: string;
  branch: string;
  baseCommit: string;
  providerSessionId?: string | undefined;
  activeIntentId?: string | undefined;
}

export interface CoordinationConversation {
  conversationId: string;
  projectId: string;
  participantAgentIds: string[];
  state: "active" | "completed";
  createdAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
}

export interface ConversationActor {
  type: "human" | "agent" | "system";
  id: string;
  ownerId?: string | undefined;
}

export type ConversationEntryType =
  | "human_message"
  | "agent_summary"
  | "tool_call"
  | "tool_result"
  | "permission_request"
  | "permission_decision"
  | "context_pack"
  | "dependency_change"
  | "plan_diff"
  | "system_event"
  | "error";

export interface ConversationEntryPayloadByType {
  human_message: { content: string };
  agent_summary: { summary: string; taskState: AgentTaskState };
  tool_call: { action: TelaegentToolAction };
  tool_result: {
    toolName: TelaegentToolName;
    outcome: "completed" | "denied" | "failed";
    safeSummary: string;
  };
  permission_request: {
    permissionClass: Exclude<PermissionClass, "AUTO_METADATA" | "ALWAYS_DENY">;
    approverOwnerIds: string[];
    purpose: string;
    expiresAt: UtcTimestamp;
  };
  permission_decision: {
    ownerId: string;
    decision: "approve" | "reject";
    targetVersion: number;
  };
  context_pack: { artifactId: string; topic: string; summary: string; expiresAt: UtcTimestamp };
  dependency_change: ReportDependencyChangeInput & { dependencyChangeId: string };
  plan_diff: ProposeReplanInput & { revisionId: string };
  system_event: { eventType: string; safeSummary: string };
  error: { code: TelaegentErrorCode; message: string; auditEventId?: string | undefined };
}

interface ConversationEntryBase<TType extends ConversationEntryType> {
  entryId: string;
  conversationId: string;
  actor: ConversationActor;
  type: TType;
  payload: ConversationEntryPayloadByType[TType];
  operationId?: string | undefined;
  correlationId: string;
  createdAt: UtcTimestamp;
}

export type ConversationEntry = {
  [TType in ConversationEntryType]: ConversationEntryBase<TType>;
}[ConversationEntryType];

export interface Intent {
  intentId: string;
  projectId: string;
  conversationId: string;
  ownerId: string;
  agentId: string;
  task: string;
  branch: string;
  baseCommit: string;
  plannedFiles: string[];
  changedFiles: string[];
  interfaces: string[];
  dependencies: string[];
  plan: string[];
  progress: number;
  blockers: string[];
  lastVerifiedAt?: UtcTimestamp | undefined;
  planningRunId?: string | undefined;
  implementationRunId?: string | undefined;
  status: IntentState;
  version: number;
  createdAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
}

export interface ConflictSignal {
  type:
    | "changed_file"
    | "planned_changed"
    | "interface"
    | "planned_file"
    | "module"
    | "base_commit";
  value: string;
  score: number;
}

export interface ConflictAssessment {
  score: number;
  level: "none" | "suggested" | "blocking";
  signals: ConflictSignal[];
}

export interface CoordinationRequest {
  requestId: string;
  projectId: string;
  conversationId: string;
  participantIntentIds: [string, string];
  participantAgentIds: [string, string];
  conflict: ConflictAssessment;
  statusSnapshot?: StatusSnapshot | undefined;
  exchangeCount: number;
  proposalId?: string | undefined;
  state: CoordinationState;
  version: number;
  expiresAt: UtcTimestamp;
  createdAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
}

export interface AgreementApproval {
  ownerId: string;
  decision: "approve" | "reject";
  proposalVersion: number;
  decidedAt: UtcTimestamp;
}

export interface Agreement {
  agreementId: string;
  projectId: string;
  conversationId: string;
  coordinationRequestId: string;
  participantOwnerIds: [string, string];
  proposalVersion: number;
  ownership: OwnershipAssignment[];
  dependencyLinks: DependencyLink[];
  requiredRules: string[];
  rationale: string;
  approvals: AgreementApproval[];
  state: AgreementState;
  createdAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
}

export interface ContextDecision {
  ownerId: string;
  decision: "approve" | "deny";
  targetVersion: number;
  approvedPaths: string[];
  decidedAt: UtcTimestamp;
}

export interface ContextRequest {
  requestId: string;
  projectId: string;
  conversationId: string;
  senderOwnerId: string;
  senderAgentId: string;
  recipientOwnerId: string;
  recipientAgentId: string;
  topic: string;
  purpose: string;
  requestedPaths: string[];
  approvedPaths: string[];
  persistence: "current-task-only" | "conversation";
  decision?: ContextDecision | undefined;
  state: ContextRequestState;
  version: number;
  expiresAt: UtcTimestamp;
  createdAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
}

export interface ContextPack {
  artifactId: string;
  requestId: string;
  projectId: string;
  topic: string;
  summary: string;
  implementationSteps: string[];
  validationChecklist: string[];
  sources: ContextPackSource[];
  sharedBy: string;
  taskScope: string;
  expiresAt: UtcTimestamp;
  state: ContextPackState;
  createdAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
}

export interface DependencyChange {
  dependencyChangeId: string;
  projectId: string;
  conversationId: string;
  intentId: string;
  agentId: string;
  interface: string;
  change: string;
  sourcePath: string;
  commit: string;
  affectedIntentIds: string[];
  createdAt: UtcTimestamp;
}

export interface PlanRevision {
  revisionId: string;
  projectId: string;
  conversationId: string;
  intentId: string;
  ownerId: string;
  dependencyChangeId: string;
  originalSteps: string[];
  revisedSteps: string[];
  affectedFiles: string[];
  validationResult: "pending" | "valid" | "invalid";
  ownerDecision?: "approve" | "reject" | undefined;
  state: PlanRevisionState;
  version: number;
  createdAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
}

export interface SafeOperationError {
  code: TelaegentErrorCode;
  message: string;
  safeDetails?: SafeJsonObject | undefined;
  auditEventId?: string | undefined;
}

export interface Operation {
  operationId: string;
  type: TelaegentToolName | "agent_run" | "workflow";
  projectId: string;
  conversationId: string;
  requestId: string;
  correlationId: string;
  agentId?: string | undefined;
  runId?: string | undefined;
  intentId?: string | undefined;
  state: OperationState;
  result?: SafeJsonValue | undefined;
  error?: SafeOperationError | undefined;
  expiresAt?: UtcTimestamp | undefined;
  createdAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
  completedAt?: UtcTimestamp | undefined;
}

export interface AuditEvent {
  eventId: string;
  sequence: number;
  projectId: string;
  conversationId: string;
  correlationId: string;
  actor: ConversationActor;
  eventType: string;
  outcome: "success" | "denied" | "failed" | "pending";
  payload: SafeJsonObject;
  timestamp: UtcTimestamp;
}

export interface IdempotencyRecord {
  projectId: string;
  senderAgentId: string;
  operation: TelaegentToolName;
  idempotencyKey: string;
  requestFingerprint: string;
  requestId: string;
  operationId: string;
  expiresAt: UtcTimestamp;
  createdAt: UtcTimestamp;
}

export interface TelaegentDatabase {
  projects: Project[];
  owners: Owner[];
  agentBindings: AgentBinding[];
  conversations: CoordinationConversation[];
  conversationEntries: ConversationEntry[];
  intents: Intent[];
  coordinationRequests: CoordinationRequest[];
  agreements: Agreement[];
  contextRequests: ContextRequest[];
  contextPacks: ContextPack[];
  dependencyChanges: DependencyChange[];
  planRevisions: PlanRevision[];
  operations: Operation[];
  events: AuditEvent[];
  idempotencyRecords: IdempotencyRecord[];
}

export type PermissionDecision =
  | {
      kind: "allow";
      permissionClass: "AUTO_METADATA";
      safeScope: unknown;
    }
  | {
      kind: "ask_human";
      permissionClass:
        | "RECIPIENT_SOURCE_APPROVAL"
        | "DUAL_OWNER_COMMITMENT"
        | "AFFECTED_OWNER_APPROVAL";
      approverOwnerIds: string[];
      expiresAt: UtcTimestamp;
      safeScope: unknown;
    }
  | {
      kind: "deny";
      permissionClass: "ALWAYS_DENY";
      code: string;
      safeReason: string;
    };

export interface AuthenticatedActor {
  actorType: "human" | "agent";
  ownerId: string;
  agentId?: string | undefined;
  projectId: string;
  provider?: AgentProvider | undefined;
}

export interface ExistingApprovalScope {
  permissionClass: Exclude<PermissionClass, "AUTO_METADATA" | "ALWAYS_DENY">;
  approvedByOwnerIds: string[];
  approvedPaths?: string[] | undefined;
  targetVersion: number;
  expiresAt: UtcTimestamp;
}

export interface PermissionEvaluationContext {
  request: TelaegentRequest;
  authenticatedActor: AuthenticatedActor;
  projectAgentIds: string[];
  participantOwnerIds?: [string, string] | undefined;
  affectedOwnerId?: string | undefined;
  inheritedPermissionClass?: PermissionClass | undefined;
  existingApproval?: ExistingApprovalScope | undefined;
  statusStale?: boolean | undefined;
  now: UtcTimestamp;
}

export type AllowedAction =
  | { kind: "continue_intent"; intentId: string; expectedVersion: number }
  | { kind: "complete_intent"; intentId: string; expectedVersion: number }
  | { kind: "request_status"; coordinationRequestId: string; expectedVersion: number }
  | { kind: "request_proposal"; coordinationRequestId: string; expectedVersion: number }
  | { kind: "decide_agreement"; agreementId: string; expectedVersion: number }
  | { kind: "decide_context_request"; requestId: string; expectedVersion: number }
  | { kind: "generate_context_pack"; requestId: string; expectedVersion: number }
  | { kind: "report_dependency_change"; intentId: string; expectedVersion: number }
  | { kind: "request_replan"; revisionId: string; expectedVersion: number }
  | { kind: "decide_plan_revision"; revisionId: string; expectedVersion: number }
  | { kind: "cancel_operation"; operationId: string };

export interface ProjectSnapshot {
  project: Project;
  owners: Owner[];
  agentBindings: AgentBinding[];
  conversation: CoordinationConversation;
  conversationEntries: ConversationEntry[];
  intents: Intent[];
  coordinationRequest: CoordinationRequest | null;
  agreement: Agreement | null;
  contextRequest: ContextRequest | null;
  contextPack: ContextPack | null;
  dependencyChange: DependencyChange | null;
  planRevision: PlanRevision | null;
  activeOperations: Operation[];
  auditEvents: AuditEvent[];
  allowedActions: AllowedAction[];
}

export interface OperationAcknowledgement {
  operationId: string;
  requestId: string;
  correlationId: string;
  state: OperationState;
  pollUrl: string;
}

export interface TelaegentErrorBody {
  code: TelaegentErrorCode;
  message: string;
  safeDetails?: SafeJsonObject | undefined;
  correlationId: string;
  auditEventId?: string | undefined;
}

export interface TelaegentErrorEnvelope {
  error: TelaegentErrorBody;
}

export interface AgreementDecisionInput {
  ownerId: string;
  decision: "approve" | "reject";
  targetVersion: number;
}

export interface ContextRequestDecisionInput {
  ownerId: string;
  decision: "approve" | "deny";
  targetVersion: number;
  approvedPaths: string[];
}

export interface PlanRevisionDecisionInput {
  ownerId: string;
  decision: "approve" | "reject";
  targetVersion: number;
}

export interface VersionedMutationInput {
  ownerId: string;
  correlationId: string;
  idempotencyKey: string;
  targetVersion: number;
}

export interface ConversationMessageInput {
  ownerId: string;
  agentId: string;
  content: string;
  correlationId: string;
  idempotencyKey: string;
}

export interface CompleteIntentHttpInput extends VersionedMutationInput {
  completion: CompleteTaskInput;
}

export interface AgreementDecisionHttpInput extends AgreementDecisionInput {
  correlationId: string;
  idempotencyKey: string;
}

export interface ContextRequestHttpInput {
  senderOwnerId: string;
  senderAgentId: string;
  recipientOwnerId: string;
  recipientAgentId: string;
  topic: string;
  purpose: string;
  requestedPaths: string[];
  persistence: "current-task-only" | "conversation";
  expiresAt: UtcTimestamp;
  correlationId: string;
  idempotencyKey: string;
}

export interface ContextRequestDecisionHttpInput extends ContextRequestDecisionInput {
  correlationId: string;
  idempotencyKey: string;
}

export interface DependencyChangeHttpInput extends VersionedMutationInput {
  change: ReportDependencyChangeInput;
}

export interface PlanRevisionDecisionHttpInput extends PlanRevisionDecisionInput {
  correlationId: string;
  idempotencyKey: string;
}

export interface CancelOperationInput {
  ownerId: string;
  correlationId: string;
  targetVersion: number;
}

export interface ResetDemoInput {
  confirmProjectId: "phoenix";
}
