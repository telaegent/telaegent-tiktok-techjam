import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import {
  type DatabaseWithTelagent,
  JsonStore,
  nextTelagentEventSequence,
} from "../store.js";
import type {
  ConflictEvaluation,
  ConversationOrchestrator,
  ConversationWorkRequest,
  IntentCandidate,
  IntentConflictEvaluator,
  IntentForConflict,
} from "./conversation-orchestrator.js";
import { RuntimeUnavailableConflictEvaluator } from "./conversation-orchestrator.js";

export type TelagentOperationState =
  | "accepted"
  | "queued"
  | "running"
  | "waiting_for_recipient"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "escalated";

export interface TelagentOperation {
  operationId: string;
  requestId: string;
  correlationId: string;
  projectId: string;
  conversationId: string | null;
  agentId: string | null;
  ownerId: string;
  type: "submit_conversation_message";
  state: TelagentOperationState;
  runId: string | null;
  safeError: { code: string; message: string } | null;
  result: { kind: "intent_published"; intentId: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

interface IdempotencyRecord {
  recordId: string;
  projectId: string;
  senderId: string;
  operation: TelagentOperation["type"];
  idempotencyKey: string;
  operationId: string;
  createdAt: string;
}

interface ProjectRecord {
  projectId: string;
  name: string;
  agentIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface OwnerRecord {
  ownerId: string;
  displayName: string;
}

interface ConversationRecord {
  conversationId: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface AgentBindingRecord {
  agentId: string;
  ownerId: string;
  projectId: string;
}

interface ConversationEntryRecord {
  entryId: string;
  projectId: string;
  conversationId: string;
  actor: { type: "human" | "agent"; ownerId: string; agentId: string | null };
  type: "human_message" | "agent_summary" | "intent" | "conflict";
  payload:
    | { content: string }
    | { summary: string }
    | { intentId: string }
    | { requestId: string; score: number };
  operationId: string;
  correlationId: string;
  sequence: number;
  createdAt: string;
}

interface AuditEventRecord {
  eventId: string;
  projectId: string;
  conversationId: string | null;
  correlationId: string;
  actor: { type: "human" | "agent" | "system"; id: string };
  eventType: string;
  outcome: string;
  payload: Record<string, unknown>;
  sequence: number;
  timestamp: string;
}

type IntentStatus = "active" | "coordination_required";

interface IntentRecord extends IntentForConflict {
  conversationId: string;
  status: IntentStatus;
  progress: number;
  planningOperationId: string;
  conflict: ValidatedConflictEvaluation;
  createdAt: string;
  updatedAt: string;
}

interface ValidatedConflictEvaluation extends ConflictEvaluation {
  severity: "none" | "coordination_suggested" | "likely_conflict";
}

interface CoordinationRequestRecord {
  requestId: string;
  projectId: string;
  conversationId: string;
  participantIntentIds: string[];
  participantAgentIds: string[];
  conflict: ValidatedConflictEvaluation;
  state: "detected";
  version: number;
  exchangeCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface PublishIntentCandidateInput {
  operationId: string;
  candidate: IntentCandidate;
  publicSummary: string;
}

export interface PublishIntentCandidateResult {
  intent: IntentRecord;
  coordinationRequest: CoordinationRequestRecord | null;
}

export interface OperationHandle {
  operationId: string;
  requestId: string;
  correlationId: string;
  state: TelagentOperationState;
  pollUrl: string;
}

export interface SubmitConversationMessageInput {
  conversationId: string;
  ownerId: string;
  agentId: string;
  content: string;
  idempotencyKey: string;
  requestId?: string | undefined;
  correlationId?: string | undefined;
}

export interface ProjectSnapshot {
  project: unknown;
  owners: unknown[];
  agentBindings: unknown[];
  conversation: unknown;
  entries: unknown[];
  intents: unknown[];
  coordinationRequests: unknown[];
  agreements: unknown[];
  contextRequests: unknown[];
  contextPacks: unknown[];
  dependencyChanges: unknown[];
  planRevisions: unknown[];
  operations: TelagentOperation[];
  events: unknown[];
  allowedActions: unknown[];
  generatedAt: string;
}

const operationStates = new Set<TelagentOperationState>([
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
]);

const terminalOperationStates = new Set<TelagentOperationState>([
  "completed",
  "failed",
  "cancelled",
  "expired",
  "escalated",
]);

const demoAgentByOwner: Readonly<Record<string, string>> = {
  alice: "alice-agent",
  bob: "bob-agent",
};

const forbiddenSnapshotKeys = new Set([
  "apikey",
  "accesstoken",
  "codexthreadid",
  "credentials",
  "env",
  "environment",
  "provideroutput",
  "providersessionid",
  "rawoutput",
  "rawprompt",
  "refreshtoken",
  "runtimeprompt",
  "sessionid",
  "stack",
  "stderr",
  "threadid",
  "workspacepath",
]);

const secretLikePatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasString = <Key extends string>(
  value: Record<string, unknown>,
  key: Key,
): value is Record<string, unknown> & Record<Key, string> =>
  typeof value[key] === "string";

const isOperation = (value: unknown): value is TelagentOperation => {
  if (
    !isRecord(value) ||
    !hasString(value, "operationId") ||
    !hasString(value, "requestId") ||
    !hasString(value, "correlationId") ||
    !hasString(value, "projectId") ||
    !hasString(value, "ownerId") ||
    !hasString(value, "state") ||
    !hasString(value, "type") ||
    !hasString(value, "createdAt") ||
    !hasString(value, "updatedAt")
  ) {
    return false;
  }
  return (
    operationStates.has(value.state as TelagentOperationState) &&
    value.type === "submit_conversation_message" &&
    (value.conversationId === null || typeof value.conversationId === "string") &&
    (value.agentId === null || typeof value.agentId === "string") &&
    (value.runId === null || typeof value.runId === "string") &&
    (value.startedAt === null || typeof value.startedAt === "string") &&
    (value.completedAt === null || typeof value.completedAt === "string")
  );
};

const isIdempotencyRecord = (value: unknown): value is IdempotencyRecord =>
  isRecord(value) &&
  hasString(value, "projectId") &&
  hasString(value, "senderId") &&
  hasString(value, "operation") &&
  hasString(value, "idempotencyKey") &&
  hasString(value, "operationId");

const isProject = (value: unknown): value is ProjectRecord =>
  isRecord(value) && hasString(value, "projectId") && hasString(value, "name");

const isOwner = (value: unknown): value is OwnerRecord =>
  isRecord(value) && hasString(value, "ownerId") && hasString(value, "displayName");

const isConversation = (value: unknown): value is ConversationRecord =>
  isRecord(value) &&
  hasString(value, "conversationId") &&
  hasString(value, "projectId");

const isAgentBinding = (value: unknown): value is AgentBindingRecord =>
  isRecord(value) &&
  hasString(value, "agentId") &&
  hasString(value, "ownerId") &&
  hasString(value, "projectId");

const isConversationEntry = (value: unknown): value is ConversationEntryRecord =>
  isRecord(value) &&
  hasString(value, "entryId") &&
  hasString(value, "projectId") &&
  hasString(value, "conversationId") &&
  Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0;

const isIntent = (value: unknown): value is IntentRecord =>
  isRecord(value) &&
  hasString(value, "intentId") &&
  hasString(value, "projectId") &&
  hasString(value, "conversationId") &&
  hasString(value, "ownerId") &&
  hasString(value, "agentId") &&
  hasString(value, "task") &&
  hasString(value, "branch") &&
  hasString(value, "status") &&
  Array.isArray(value.plannedFiles) &&
  Array.isArray(value.changedFiles) &&
  Array.isArray(value.interfaces) &&
  Array.isArray(value.dependencies) &&
  Array.isArray(value.planSteps);

const isAuditEvent = (value: unknown): value is AuditEventRecord =>
  isRecord(value) &&
  hasString(value, "eventId") &&
  hasString(value, "projectId") &&
  Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0;

const sanitizeSnapshotValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeSnapshotValue);
  if (!isRecord(value)) return structuredClone(value);
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (forbiddenSnapshotKeys.has(normalizedKey)) continue;
    safe[key] = sanitizeSnapshotValue(child);
  }
  return safe;
};

const recordsForProject = (values: unknown[], projectId: string): unknown[] =>
  values.filter(
    (value) => isRecord(value) && value.projectId === projectId,
  ).map(sanitizeSnapshotValue);

const publicOperation = (operation: TelagentOperation): TelagentOperation => ({
  operationId: operation.operationId,
  requestId: operation.requestId,
  correlationId: operation.correlationId,
  projectId: operation.projectId,
  conversationId: operation.conversationId,
  agentId: operation.agentId,
  ownerId: operation.ownerId,
  type: operation.type,
  state: operation.state,
  runId: operation.runId,
  safeError:
    isRecord(operation.safeError) &&
    typeof operation.safeError.code === "string" &&
    typeof operation.safeError.message === "string"
      ? {
          code: operation.safeError.code,
          message: operation.safeError.message,
        }
      : null,
  result:
    isRecord(operation.result) &&
    operation.result.kind === "intent_published" &&
    typeof operation.result.intentId === "string"
      ? { kind: "intent_published", intentId: operation.result.intentId }
      : null,
  createdAt: operation.createdAt,
  startedAt: operation.startedAt,
  completedAt: operation.completedAt,
  updatedAt: operation.updatedAt,
});

const operationHandle = (operation: TelagentOperation): OperationHandle => ({
  operationId: operation.operationId,
  requestId: operation.requestId,
  correlationId: operation.correlationId,
  state: operation.state,
  pollUrl: `/api/telagent/operations/${operation.operationId}`,
});

const boundedPublicSummary = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Invalid public summary");
  const summary = value.trim();
  if (summary.length === 0 || summary.length > 2_000) {
    throw new Error("Invalid public summary");
  }
  if (secretLikePatterns.some((pattern) => pattern.test(summary))) {
    throw new Error("Public summary contains secret-like content");
  }
  return summary;
};

const boundedSharedHumanContent = (value: string): string => {
  const content = value.trim();
  if (content.length === 0 || content.length > 50_000) {
    throw new HttpError(400, "Invalid shared conversation message");
  }
  if (secretLikePatterns.some((pattern) => pattern.test(content))) {
    throw new HttpError(400, "Shared message contains secret-like content");
  }
  return content;
};

const boundedText = (value: unknown, label: string, maximum: number): string => {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
};

const boundedStringList = (
  value: unknown,
  label: string,
  maximumItems: number,
  maximumItemLength: number,
): string[] => {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`Invalid ${label}`);
  }
  return [
    ...new Set(
      value.map((item) => boundedText(item, label, maximumItemLength)),
    ),
  ];
};

const normalizedIntentPath = (value: unknown): string => {
  const normalized = boundedText(value, "intent path", 260)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    segments.some((segment) => segment === "." || segment === ".." || segment === "") ||
    normalized.includes("\0") ||
    segments.some(
      (segment) =>
        segment === ".env" ||
        segment.startsWith(".env.") ||
        segment === ".git",
    )
  ) {
    throw new Error("Invalid intent path");
  }
  return normalized;
};

const validatedIntentCandidate = (value: unknown): IntentCandidate => {
  if (!isRecord(value)) throw new Error("Invalid intent candidate");
  const branch = boundedText(value.branch, "intent branch", 160);
  if (
    !/^[A-Za-z0-9._/-]+$/.test(branch) ||
    branch.startsWith("/") ||
    branch.startsWith("-") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("//")
  ) {
    throw new Error("Invalid intent branch");
  }
  const plannedFiles = boundedStringList(
    value.plannedFiles,
    "planned files",
    50,
    260,
  ).map(normalizedIntentPath);
  return {
    task: boundedText(value.task, "intent task", 500),
    branch,
    plannedFiles: [...new Set(plannedFiles)],
    interfaces: boundedStringList(value.interfaces, "interfaces", 50, 160),
    dependencies: boundedStringList(
      value.dependencies,
      "dependencies",
      50,
      160,
    ),
    planSteps: boundedStringList(value.planSteps, "plan steps", 20, 500),
  };
};

const validatedConflictEvaluation = (
  value: ConflictEvaluation,
): ValidatedConflictEvaluation => {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.score) ||
    value.score < 0 ||
    value.score > 100 ||
    !Array.isArray(value.signals) ||
    value.signals.length > 50
  ) {
    throw new Error("Invalid deterministic conflict result");
  }
  const signals = value.signals.map((signal) => {
    if (
      !isRecord(signal) ||
      typeof signal.score !== "number" ||
      !Number.isSafeInteger(signal.score) ||
      signal.score < 0 ||
      signal.score > 5
    ) {
      throw new Error("Invalid deterministic conflict signal");
    }
    return {
      type: boundedText(signal.type, "conflict signal type", 80),
      score: signal.score,
      value: boundedText(signal.value, "conflict signal value", 260),
    };
  });
  const evidenceScore = signals.reduce((total, signal) => total + signal.score, 0);
  if (evidenceScore !== value.score) {
    throw new Error("Conflict score does not match its deterministic evidence");
  }
  return {
    score: value.score,
    signals,
    severity:
      value.score >= 5
        ? "likely_conflict"
        : value.score >= 3
          ? "coordination_suggested"
          : "none",
  };
};

export class TelagentService {
  private readonly activeOperations = new Map<string, Promise<void>>();

  constructor(
    private readonly store: JsonStore,
    private readonly orchestrator: ConversationOrchestrator,
    private readonly conflictEvaluator: IntentConflictEvaluator =
      new RuntimeUnavailableConflictEvaluator(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async initializeDemo(): Promise<ProjectSnapshot> {
    const timestamp = this.now();
    await this.store.mutate((database) => {
      if (!database.telagent.projects.some(
        (candidate) => isProject(candidate) && candidate.projectId === "phoenix",
      )) {
        database.telagent.projects.push({
          projectId: "phoenix",
          name: "Phoenix Web App",
          agentIds: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        } satisfies ProjectRecord);
      }
      for (const owner of [
        { ownerId: "alice", displayName: "Alice" },
        { ownerId: "bob", displayName: "Bob" },
      ] satisfies OwnerRecord[]) {
        if (!database.telagent.owners.some(
          (candidate) => isOwner(candidate) && candidate.ownerId === owner.ownerId,
        )) {
          database.telagent.owners.push(owner);
        }
      }
      if (!database.telagent.conversations.some(
        (candidate) =>
          isConversation(candidate) &&
          candidate.conversationId === "conv_phoenix_demo",
      )) {
        database.telagent.conversations.push({
          conversationId: "conv_phoenix_demo",
          projectId: "phoenix",
          title: "Phoenix coordination",
          createdAt: timestamp,
          updatedAt: timestamp,
        } satisfies ConversationRecord);
        this.appendAuditEvent(database, {
          projectId: "phoenix",
          conversationId: "conv_phoenix_demo",
          correlationId: "corr_demo_initialize",
          actor: { type: "system", id: "telagent" },
          eventType: "demo_initialized",
          outcome: "completed",
          payload: {},
          timestamp,
        });
      }
    });
    return this.getProjectSnapshot("phoenix");
  }

  async submitConversationMessage(
    input: SubmitConversationMessageInput,
  ): Promise<OperationHandle> {
    const sharedContent = boundedSharedHumanContent(input.content);
    const timestamp = this.now();
    const operationId = randomUUID();
    const requestId = input.requestId ?? randomUUID();
    const correlationId = input.correlationId ?? randomUUID();
    const accepted = await this.store.mutate((database) => {
      const conversation = database.telagent.conversations.find(
        (candidate) =>
          isConversation(candidate) &&
          candidate.conversationId === input.conversationId,
      );
      if (!conversation || !isConversation(conversation)) {
        throw new HttpError(404, "Telagent conversation not found");
      }
      const ownerExists = database.telagent.owners.some(
        (candidate) => isOwner(candidate) && candidate.ownerId === input.ownerId,
      );
      if (!ownerExists) {
        throw new HttpError(403, "Owner is not part of this Telagent project");
      }
      const binding = database.telagent.agentBindings.find(
        (candidate): candidate is AgentBindingRecord =>
          isAgentBinding(candidate) && candidate.agentId === input.agentId,
      );
      if (
        binding &&
        (binding.projectId !== conversation.projectId ||
          binding.ownerId !== input.ownerId)
      ) {
        throw new HttpError(403, "Agent is not owned by the acting owner");
      }
      if (!binding && demoAgentByOwner[input.ownerId] !== input.agentId) {
        throw new HttpError(403, "Agent is not owned by the acting owner");
      }
      const senderId = `${input.ownerId}:${input.agentId}`;
      const duplicate = database.telagent.idempotencyRecords.find(
        (candidate) =>
          isIdempotencyRecord(candidate) &&
          candidate.projectId === conversation.projectId &&
          candidate.senderId === senderId &&
          candidate.operation === "submit_conversation_message" &&
          candidate.idempotencyKey === input.idempotencyKey,
      );
      if (duplicate && isIdempotencyRecord(duplicate)) {
        const original = database.telagent.operations.find(
          (candidate) =>
            isOperation(candidate) &&
            candidate.operationId === duplicate.operationId,
        );
        if (!original || !isOperation(original)) {
          throw new Error("Idempotency record references a missing Operation");
        }
        return { operation: structuredClone(original), created: false };
      }
      const activeOperation = database.telagent.operations.find(
        (candidate) =>
          isOperation(candidate) &&
          candidate.projectId === conversation.projectId &&
          candidate.agentId === input.agentId &&
          !terminalOperationStates.has(candidate.state),
      );
      if (activeOperation) {
        throw new HttpError(409, "Agent already has an active Telagent Operation");
      }
      const activeIntent = database.telagent.intents.find(
        (candidate) =>
          isIntent(candidate) &&
          candidate.projectId === conversation.projectId &&
          candidate.agentId === input.agentId &&
          (candidate.status === "active" ||
            candidate.status === "coordination_required"),
      );
      if (activeIntent) {
        throw new HttpError(409, "Agent already has an active Telagent intent");
      }

      const operation: TelagentOperation = {
        operationId,
        requestId,
        correlationId,
        projectId: conversation.projectId,
        conversationId: conversation.conversationId,
        agentId: input.agentId,
        ownerId: input.ownerId,
        type: "submit_conversation_message",
        state: "accepted",
        runId: null,
        safeError: null,
        result: null,
        createdAt: timestamp,
        startedAt: null,
        completedAt: null,
        updatedAt: timestamp,
      };
      database.telagent.operations.push(operation);
      database.telagent.idempotencyRecords.push({
        recordId: randomUUID(),
        projectId: conversation.projectId,
        senderId,
        operation: operation.type,
        idempotencyKey: input.idempotencyKey,
        operationId,
        createdAt: timestamp,
      } satisfies IdempotencyRecord);
      const entrySequence = this.nextConversationEntrySequence(
        database,
        conversation.conversationId,
      );
      database.telagent.conversationEntries.push({
        entryId: randomUUID(),
        projectId: conversation.projectId,
        conversationId: conversation.conversationId,
        actor: {
          type: "human",
          ownerId: input.ownerId,
          agentId: input.agentId,
        },
        type: "human_message",
        payload: { content: sharedContent },
        operationId,
        correlationId,
        sequence: entrySequence,
        createdAt: timestamp,
      } satisfies ConversationEntryRecord);
      conversation.updatedAt = timestamp;
      this.appendAuditEvent(database, {
        projectId: conversation.projectId,
        conversationId: conversation.conversationId,
        correlationId,
        actor: { type: "human", id: input.ownerId },
        eventType: "operation_accepted",
        outcome: "accepted",
        payload: { operationId, operationType: operation.type },
        timestamp,
      });
      return { operation: structuredClone(operation), created: true };
    });

    if (accepted.created) {
      const work: ConversationWorkRequest = {
        projectId: accepted.operation.projectId,
        conversationId: input.conversationId,
        operationId,
        requestId,
        correlationId,
        ownerId: input.ownerId,
        agentId: input.agentId,
        content: sharedContent,
      };
      queueMicrotask(() => this.startBackgroundOperation(work));
    }
    return operationHandle(accepted.operation);
  }

  getOperation(operationId: string): TelagentOperation {
    const operation = this.store
      .snapshot()
      .telagent.operations.find(
        (candidate) =>
          isOperation(candidate) && candidate.operationId === operationId,
      );
    if (!operation || !isOperation(operation)) {
      throw new HttpError(404, "Telagent Operation not found");
    }
    return publicOperation(operation);
  }

  async publishIntentCandidate(
    input: PublishIntentCandidateInput,
  ): Promise<PublishIntentCandidateResult> {
    const candidate = validatedIntentCandidate(input.candidate);
    const publicSummary = boundedPublicSummary(input.publicSummary);
    const timestamp = this.now();
    return this.store.mutate((database) => {
      const operation = this.findMutableOperation(database, input.operationId);
      if (operation.state !== "running") {
        throw new Error("Intent can only be published by a running Operation");
      }
      if (!operation.conversationId || !operation.agentId) {
        throw new Error("Operation is missing its conversation or Agent");
      }
      const existingActiveIntent = database.telagent.intents.find(
        (value) =>
          isIntent(value) &&
          value.projectId === operation.projectId &&
          value.agentId === operation.agentId &&
          (value.status === "active" || value.status === "coordination_required"),
      );
      if (existingActiveIntent) {
        throw new Error("Agent already has an active intent");
      }
      const intentId = randomUUID();
      const conflictCandidate: IntentForConflict = {
        ...candidate,
        intentId,
        projectId: operation.projectId,
        ownerId: operation.ownerId,
        agentId: operation.agentId,
        changedFiles: [],
        baseCommit: null,
      };
      const activeIntents = database.telagent.intents.filter(
        (value): value is IntentRecord =>
          isIntent(value) &&
          value.projectId === operation.projectId &&
          value.agentId !== operation.agentId &&
          (value.status === "active" || value.status === "coordination_required"),
      );
      const conflict = validatedConflictEvaluation(
        this.conflictEvaluator.evaluate(conflictCandidate, activeIntents),
      );
      const intent: IntentRecord = {
        ...conflictCandidate,
        conversationId: operation.conversationId,
        status: conflict.score >= 5 ? "coordination_required" : "active",
        progress: 0,
        planningOperationId: operation.operationId,
        conflict,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      database.telagent.intents.push(intent);
      database.telagent.conversationEntries.push({
        entryId: randomUUID(),
        projectId: operation.projectId,
        conversationId: operation.conversationId,
        actor: {
          type: "agent",
          ownerId: operation.ownerId,
          agentId: operation.agentId,
        },
        type: "intent",
        payload: { intentId },
        operationId: operation.operationId,
        correlationId: operation.correlationId,
        sequence: this.nextConversationEntrySequence(
          database,
          operation.conversationId,
        ),
        createdAt: timestamp,
      } satisfies ConversationEntryRecord);
      this.appendAuditEvent(database, {
        projectId: operation.projectId,
        conversationId: operation.conversationId,
        correlationId: operation.correlationId,
        actor: { type: "agent", id: operation.agentId },
        eventType: "intent_published",
        outcome: intent.status,
        payload: { intentId },
        timestamp,
      });

      let coordinationRequest: CoordinationRequestRecord | null = null;
      if (conflict.score >= 3) {
        const requestId = randomUUID();
        coordinationRequest = {
          requestId,
          projectId: operation.projectId,
          conversationId: operation.conversationId,
          participantIntentIds: [
            ...activeIntents.map((activeIntent) => activeIntent.intentId),
            intentId,
          ],
          participantAgentIds: [
            ...activeIntents.map((activeIntent) => activeIntent.agentId),
            operation.agentId,
          ],
          conflict,
          state: "detected",
          version: 1,
          exchangeCount: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          expiresAt: new Date(
            new Date(timestamp).getTime() + 30 * 60 * 1_000,
          ).toISOString(),
        };
        database.telagent.coordinationRequests.push(coordinationRequest);
        database.telagent.conversationEntries.push({
          entryId: randomUUID(),
          projectId: operation.projectId,
          conversationId: operation.conversationId,
          actor: { type: "agent", ownerId: operation.ownerId, agentId: operation.agentId },
          type: "conflict",
          payload: { requestId, score: conflict.score },
          operationId: operation.operationId,
          correlationId: operation.correlationId,
          sequence: this.nextConversationEntrySequence(
            database,
            operation.conversationId,
          ),
          createdAt: timestamp,
        } satisfies ConversationEntryRecord);
        this.appendAuditEvent(database, {
          projectId: operation.projectId,
          conversationId: operation.conversationId,
          correlationId: operation.correlationId,
          actor: { type: "system", id: "telagent" },
          eventType: "conflict_detected",
          outcome: conflict.severity,
          payload: { requestId, intentId, score: conflict.score },
          timestamp,
        });
      }
      database.telagent.conversationEntries.push({
        entryId: randomUUID(),
        projectId: operation.projectId,
        conversationId: operation.conversationId,
        actor: {
          type: "agent",
          ownerId: operation.ownerId,
          agentId: operation.agentId,
        },
        type: "agent_summary",
        payload: { summary: publicSummary },
        operationId: operation.operationId,
        correlationId: operation.correlationId,
        sequence: this.nextConversationEntrySequence(
          database,
          operation.conversationId,
        ),
        createdAt: timestamp,
      } satisfies ConversationEntryRecord);
      operation.state = "completed";
      operation.result = { kind: "intent_published", intentId };
      operation.completedAt = timestamp;
      operation.updatedAt = timestamp;
      const conversation = database.telagent.conversations.find(
        (value): value is ConversationRecord =>
          isConversation(value) &&
          value.projectId === operation.projectId &&
          value.conversationId === operation.conversationId,
      );
      if (conversation) conversation.updatedAt = timestamp;
      this.appendAuditEvent(database, {
        projectId: operation.projectId,
        conversationId: operation.conversationId,
        correlationId: operation.correlationId,
        actor: { type: "agent", id: operation.agentId },
        eventType: "operation_completed",
        outcome: "completed",
        payload: { operationId: operation.operationId },
        timestamp,
      });
      return {
        intent: structuredClone(intent),
        coordinationRequest: coordinationRequest
          ? structuredClone(coordinationRequest)
          : null,
      };
    });
  }

  getProjectSnapshot(projectId: string): ProjectSnapshot {
    const database = this.store.snapshot();
    const project = database.telagent.projects.find(
      (candidate) => isProject(candidate) && candidate.projectId === projectId,
    );
    if (!project || !isProject(project)) {
      throw new HttpError(404, "Telagent project not found");
    }
    const conversation = database.telagent.conversations.find(
      (candidate) =>
        isConversation(candidate) && candidate.projectId === projectId,
    );
    const entries = database.telagent.conversationEntries
      .filter(
        (candidate): candidate is ConversationEntryRecord =>
          isConversationEntry(candidate) && candidate.projectId === projectId,
      )
      .sort((left, right) => left.sequence - right.sequence);
    const operations = database.telagent.operations
      .filter(
        (candidate): candidate is TelagentOperation =>
          isOperation(candidate) && candidate.projectId === projectId,
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.operationId.localeCompare(right.operationId),
      );
    const events = database.telagent.events
      .filter(
        (candidate): candidate is AuditEventRecord =>
          isAuditEvent(candidate) && candidate.projectId === projectId,
      )
      .sort((left, right) => left.sequence - right.sequence);
    return {
      project: sanitizeSnapshotValue(project),
      owners: database.telagent.owners
        .filter(isOwner)
        .map((owner) => sanitizeSnapshotValue(owner)),
      agentBindings: recordsForProject(database.telagent.agentBindings, projectId),
      conversation: conversation ? sanitizeSnapshotValue(conversation) : null,
      entries: entries.map(sanitizeSnapshotValue),
      intents: recordsForProject(database.telagent.intents, projectId),
      coordinationRequests: recordsForProject(
        database.telagent.coordinationRequests,
        projectId,
      ),
      agreements: recordsForProject(database.telagent.agreements, projectId),
      contextRequests: recordsForProject(
        database.telagent.contextRequests,
        projectId,
      ),
      contextPacks: recordsForProject(database.telagent.contextPacks, projectId),
      dependencyChanges: recordsForProject(
        database.telagent.dependencyChanges,
        projectId,
      ),
      planRevisions: recordsForProject(database.telagent.planRevisions, projectId),
      operations: operations.map(publicOperation),
      events: events.map(sanitizeSnapshotValue),
      allowedActions: [],
      generatedAt: this.now(),
    };
  }

  async reconcileOnStartup(): Promise<void> {
    const timestamp = this.now();
    await this.store.mutate((database) => {
      for (const candidate of database.telagent.operations) {
        if (!isOperation(candidate)) continue;
        if (candidate.state === "accepted" || candidate.state === "queued" || candidate.state === "running") {
          candidate.state = "failed";
          candidate.safeError = {
            code: "SERVER_RESTARTED",
            message: "Server restarted while this Operation was active",
          };
          candidate.completedAt = timestamp;
          candidate.updatedAt = timestamp;
          this.appendAuditEvent(database, {
            projectId: candidate.projectId,
            conversationId: candidate.conversationId,
            correlationId: candidate.correlationId,
            actor: { type: "system", id: "telagent" },
            eventType: "operation_reconciled",
            outcome: "failed",
            payload: { operationId: candidate.operationId, reason: "server_restart" },
            timestamp,
          });
        }
      }
    });
  }

  private startBackgroundOperation(request: ConversationWorkRequest): void {
    if (this.activeOperations.has(request.operationId)) return;
    const execution = this.executeConversationOperation(request);
    this.activeOperations.set(request.operationId, execution);
    void execution
      .finally(() => {
        if (this.activeOperations.get(request.operationId) === execution) {
          this.activeOperations.delete(request.operationId);
        }
      })
      .catch(() => undefined);
  }

  private async executeConversationOperation(
    request: ConversationWorkRequest,
  ): Promise<void> {
    try {
      await this.transitionOperation(request.operationId, "queued");
      await this.transitionOperation(request.operationId, "running");
      const result = await this.orchestrator.processMessage(request);
      await this.publishIntentCandidate({
        operationId: request.operationId,
        candidate: result.intent,
        publicSummary: result.publicSummary,
      });
    } catch {
      const timestamp = this.now();
      await this.store.mutate((database) => {
        const operation = database.telagent.operations.find(
          (candidate) =>
            isOperation(candidate) &&
            candidate.operationId === request.operationId,
        );
        if (!operation || !isOperation(operation) || terminalOperationStates.has(operation.state)) {
          return;
        }
        operation.state = "failed";
        operation.safeError = {
          code: "BACKGROUND_WORK_FAILED",
          message: "The Telagent background operation failed",
        };
        operation.completedAt = timestamp;
        operation.updatedAt = timestamp;
        this.appendAuditEvent(database, {
          projectId: request.projectId,
          conversationId: request.conversationId,
          correlationId: request.correlationId,
          actor: { type: "system", id: "telagent" },
          eventType: "operation_failed",
          outcome: "failed",
          payload: { operationId: request.operationId, code: "BACKGROUND_WORK_FAILED" },
          timestamp,
        });
      });
    }
  }

  private async transitionOperation(
    operationId: string,
    state: "queued" | "running",
  ): Promise<void> {
    const timestamp = this.now();
    await this.store.mutate((database) => {
      const operation = this.findMutableOperation(database, operationId);
      const expected = state === "queued" ? "accepted" : "queued";
      if (operation.state !== expected) {
        throw new Error(`Invalid Operation transition: ${operation.state} -> ${state}`);
      }
      operation.state = state;
      operation.updatedAt = timestamp;
      if (state === "running") operation.startedAt = timestamp;
      this.appendAuditEvent(database, {
        projectId: operation.projectId,
        conversationId: operation.conversationId,
        correlationId: operation.correlationId,
        actor: { type: "system", id: "telagent" },
        eventType: `operation_${state}`,
        outcome: state,
        payload: { operationId },
        timestamp,
      });
    });
  }

  private findMutableOperation(
    database: DatabaseWithTelagent,
    operationId: string,
  ): TelagentOperation {
    const operation = database.telagent.operations.find(
      (candidate) =>
        isOperation(candidate) && candidate.operationId === operationId,
    );
    if (!operation || !isOperation(operation)) {
      throw new Error("Operation disappeared during execution");
    }
    return operation;
  }

  private appendAuditEvent(
    database: DatabaseWithTelagent,
    input: Omit<AuditEventRecord, "eventId" | "sequence">,
  ): void {
    database.telagent.events.push({
      ...input,
      eventId: randomUUID(),
      sequence: nextTelagentEventSequence(database),
    } satisfies AuditEventRecord);
  }

  private nextConversationEntrySequence(
    database: DatabaseWithTelagent,
    conversationId: string,
  ): number {
    let maximum = 0;
    for (const candidate of database.telagent.conversationEntries) {
      if (
        isConversationEntry(candidate) &&
        candidate.conversationId === conversationId
      ) {
        maximum = Math.max(maximum, candidate.sequence);
      }
    }
    return maximum + 1;
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
