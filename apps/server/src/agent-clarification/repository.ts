import { z } from "zod";
import { isGitHubRepositoryId } from "../authorization/github-repository-id.js";
import type { AgentProvider } from "../runtime-contract.js";
import {
  AGENT_CLARIFICATION_LIMITS,
  CLARIFICATION_REASON_CODES,
  clarificationDialogueOutputSchema,
  type ClarificationReasonCode,
} from "./contract.js";

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const provider = z.enum(["codex", "claude"]);
const taskState = z.enum([
  "recipient_running",
  "dialogue_running",
  "human_required",
  "completed",
  "cancelled",
  "expired",
]);

const stepSchema = z.strictObject({
  stepId: uuid,
  parentStepId: uuid.nullable(),
  sequence: z.number().int().min(1).max(2),
  askedByUserId: uuid,
  askedToUserId: uuid,
  question: z
    .string()
    .min(1)
    .max(AGENT_CLARIFICATION_LIMITS.maxQuestionBytes)
    .nullable(),
  answer: z
    .string()
    .min(1)
    .max(AGENT_CLARIFICATION_LIMITS.maxAnswerBytes)
    .nullable(),
  status: z.enum(["pending", "human_required", "resolved"]),
  reasonCode: z.enum(CLARIFICATION_REASON_CODES).nullable(),
  sharedBasisMessageIds: z
    .array(uuid)
    .max(AGENT_CLARIFICATION_LIMITS.maxSharedBasisMessageIds),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  answerHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  humanRequiredReason: z
    .enum(["new_authority", "private_context", "ambiguous", "safety"])
    .nullable(),
  createdAt: timestamp,
  resolvedAt: timestamp.nullable(),
});

export const agentClarificationTaskSchema = z.strictObject({
  taskId: uuid,
  originSharedMessageId: uuid,
  conversationId: uuid,
  githubRepositoryId: z.string().refine(isGitHubRepositoryId),
  requesterUserId: uuid,
  responderUserId: uuid,
  requesterProvider: provider,
  requesterModel: z.string().min(1).max(64).nullable(),
  responderProvider: provider,
  responderModel: z.string().min(1).max(64).nullable(),
  state: taskState,
  questionsUsed: z.number().int().min(0).max(2),
  followUpRounds: z.number().int().min(0).max(5),
  version: z.number().int().min(0),
  expectedUserId: uuid.nullable(),
  expectedLane: z.enum(["private_work", "clarification_dialogue", "human"]).nullable(),
  currentStepId: uuid.nullable(),
  expiresAt: timestamp,
  steps: z.array(stepSchema).max(2),
});

export type AgentClarificationTask = z.infer<
  typeof agentClarificationTaskSchema
>;
export type AgentClarificationStep = z.infer<typeof stepSchema>;

const grantOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("granted") }),
  z.strictObject({ outcome: z.literal("unavailable") }),
]);
const activationOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("active"), task: agentClarificationTaskSchema }),
  z.strictObject({ outcome: z.literal("consent_missing") }),
  z.strictObject({ outcome: z.literal("unavailable") }),
]);
const loadOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("available"), task: agentClarificationTaskSchema }),
  z.strictObject({ outcome: z.literal("unavailable") }),
]);
const transitionOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.enum(["route_dialogue", "resume_recipient", "human_required"]),
    task: agentClarificationTaskSchema,
  }),
  z.strictObject({ outcome: z.literal("exhausted") }),
  z.strictObject({ outcome: z.literal("stale") }),
  z.strictObject({ outcome: z.literal("unavailable") }),
]);
const stopOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("stopped") }),
  z.strictObject({ outcome: z.literal("already_terminal") }),
  z.strictObject({ outcome: z.literal("unavailable") }),
]);

export type AgentClarificationTransition = z.infer<
  typeof transitionOutcomeSchema
>;

export interface AgentClarificationRepository {
  grantOriginator(input: Readonly<{
    originSharedMessageId: string;
    actorUserId: string;
    provider: AgentProvider;
    model: string | null;
  }>): Promise<z.infer<typeof grantOutcomeSchema>>;
  activate(input: Readonly<{
    taskId: string;
    responderUserId: string;
    provider: AgentProvider;
    model: string | null;
  }>): Promise<z.infer<typeof activationOutcomeSchema>>;
  load(input: Readonly<{
    taskId: string;
    actorUserId: string;
  }>): Promise<z.infer<typeof loadOutcomeSchema>>;
  list(input: Readonly<{
    actorUserId: string;
    githubRepositoryId: string;
    conversationId: string;
  }>): Promise<AgentClarificationTask[]>;
  beginQuestion(input: Readonly<{
    taskId: string;
    actorUserId: string;
    stepId: string;
    question: string;
    reasonCode: ClarificationReasonCode;
    sharedBasisMessageIds: readonly string[];
    contentHash: string;
    expectedVersion: number;
  }>): Promise<AgentClarificationTransition>;
  recordDialogueResult(input: Readonly<{
    taskId: string;
    actorUserId: string;
    currentStepId: string;
    counterStepId: string;
    expectedVersion: number;
    output: z.infer<typeof clarificationDialogueOutputSchema>;
    contentHash: string | null;
  }>): Promise<AgentClarificationTransition>;
  continueWithHumanAnswer(input: Readonly<{
    taskId: string;
    actorUserId: string;
    currentStepId: string;
    answer: string;
    answerHash: string;
    expectedVersion: number;
  }>): Promise<AgentClarificationTransition>;
  stop(input: Readonly<{
    taskId: string;
    actorUserId: string;
  }>): Promise<z.infer<typeof stopOutcomeSchema>>;
  complete(input: Readonly<{
    taskId: string;
    actorUserId: string;
  }>): Promise<z.infer<typeof stopOutcomeSchema>>;
}

export interface AgentClarificationRpcClient {
  grantAgentDialogueOriginator(input: Parameters<AgentClarificationRepository["grantOriginator"]>[0]): Promise<unknown>;
  activateAgentClarification(input: Parameters<AgentClarificationRepository["activate"]>[0]): Promise<unknown>;
  loadAgentClarification(input: Parameters<AgentClarificationRepository["load"]>[0]): Promise<unknown>;
  listAgentClarifications(input: Parameters<AgentClarificationRepository["list"]>[0]): Promise<unknown>;
  beginAgentClarificationQuestion(input: Parameters<AgentClarificationRepository["beginQuestion"]>[0]): Promise<unknown>;
  recordAgentClarificationDialogueResult(input: Parameters<AgentClarificationRepository["recordDialogueResult"]>[0]): Promise<unknown>;
  continueAgentClarification(input: Parameters<AgentClarificationRepository["continueWithHumanAnswer"]>[0]): Promise<unknown>;
  stopAgentClarification(input: Parameters<AgentClarificationRepository["stop"]>[0] & { completed: boolean }): Promise<unknown>;
}

/** Strict mapper around service-role RPCs; malformed persistence fails closed. */
export class SupabaseAgentClarificationRepository
  implements AgentClarificationRepository
{
  constructor(private readonly client: AgentClarificationRpcClient) {}

  async grantOriginator(input: Parameters<AgentClarificationRepository["grantOriginator"]>[0]) {
    return grantOutcomeSchema.parse(await this.client.grantAgentDialogueOriginator(input));
  }

  async activate(input: Parameters<AgentClarificationRepository["activate"]>[0]) {
    return activationOutcomeSchema.parse(await this.client.activateAgentClarification(input));
  }

  async load(input: Parameters<AgentClarificationRepository["load"]>[0]) {
    return loadOutcomeSchema.parse(await this.client.loadAgentClarification(input));
  }

  async list(input: Parameters<AgentClarificationRepository["list"]>[0]) {
    return z.array(agentClarificationTaskSchema).max(50).parse(
      await this.client.listAgentClarifications(input),
    );
  }

  async beginQuestion(input: Parameters<AgentClarificationRepository["beginQuestion"]>[0]) {
    return transitionOutcomeSchema.parse(
      await this.client.beginAgentClarificationQuestion(input),
    );
  }

  async recordDialogueResult(
    input: Parameters<AgentClarificationRepository["recordDialogueResult"]>[0],
  ) {
    return transitionOutcomeSchema.parse(
      await this.client.recordAgentClarificationDialogueResult(input),
    );
  }

  async continueWithHumanAnswer(
    input: Parameters<AgentClarificationRepository["continueWithHumanAnswer"]>[0],
  ) {
    return transitionOutcomeSchema.parse(
      await this.client.continueAgentClarification(input),
    );
  }

  async stop(input: Parameters<AgentClarificationRepository["stop"]>[0]) {
    return stopOutcomeSchema.parse(
      await this.client.stopAgentClarification({ ...input, completed: false }),
    );
  }

  async complete(input: Parameters<AgentClarificationRepository["complete"]>[0]) {
    return stopOutcomeSchema.parse(
      await this.client.stopAgentClarification({ ...input, completed: true }),
    );
  }
}
