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
const revokeOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("revoked"),
    /**
     * The exchanges the revocation cancelled, so the caller can wake the loops
     * it has parked on them. Empty is the ordinary case: consent is usually
     * withdrawn before any recipient picked it up.
     */
    cancelledTaskIds: z.array(z.string().uuid()),
  }),
  z.strictObject({ outcome: z.literal("unavailable") }),
]);
const activationOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("active"), task: agentClarificationTaskSchema }),
  z.strictObject({ outcome: z.literal("consent_missing") }),
  // Separate from `consent_missing`: the originator did agree, and the hour
  // that agreement was good for has run out. Nothing here treats them
  // differently yet; an operator reading logs has to be able to.
  z.strictObject({ outcome: z.literal("consent_expired") }),
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
  /**
   * Withdraws the originator's consent, and cancels whatever it is feeding.
   *
   * The one path that reaches consent before any exchange exists. `stop` also
   * revokes, and needs a clarification task to stop; the window this covers is
   * the one between `Send` and the recipient's agent picking the grant up.
   */
  revokeOriginator(input: Readonly<{
    originSharedMessageId: string;
    actorUserId: string;
  }>): Promise<z.infer<typeof revokeOutcomeSchema>>;
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
  /**
   * Cancels every exchange left mid-flight, for restart recovery.
   *
   * Deliberately not scoped to an actor or a task: the process that could name
   * the exchanges it was driving is the one that died.
   */
  reconcileDriving(input: Readonly<{ updatedAt: string }>): Promise<number>;
  /**
   * Deletes question and answer text whose task lifetime has run out.
   *
   * Retention, not access control -- every RPC already refuses an expired
   * task. This is what covers the exchange both people simply walk away from,
   * which no other call ever touches again.
   */
  sweepExpiredPayloads(): Promise<number>;
}

export interface AgentClarificationRpcClient {
  grantAgentDialogueOriginator(input: Parameters<AgentClarificationRepository["grantOriginator"]>[0]): Promise<unknown>;
  revokeAgentDialogueOriginator(input: Parameters<AgentClarificationRepository["revokeOriginator"]>[0]): Promise<unknown>;
  activateAgentClarification(input: Parameters<AgentClarificationRepository["activate"]>[0]): Promise<unknown>;
  loadAgentClarification(input: Parameters<AgentClarificationRepository["load"]>[0]): Promise<unknown>;
  listAgentClarifications(input: Parameters<AgentClarificationRepository["list"]>[0]): Promise<unknown>;
  beginAgentClarificationQuestion(input: Parameters<AgentClarificationRepository["beginQuestion"]>[0]): Promise<unknown>;
  recordAgentClarificationDialogueResult(input: Parameters<AgentClarificationRepository["recordDialogueResult"]>[0]): Promise<unknown>;
  continueAgentClarification(input: Parameters<AgentClarificationRepository["continueWithHumanAnswer"]>[0]): Promise<unknown>;
  stopAgentClarification(input: Parameters<AgentClarificationRepository["stop"]>[0] & { completed: boolean }): Promise<unknown>;
  reconcileRunningAgentClarifications(input: Parameters<AgentClarificationRepository["reconcileDriving"]>[0]): Promise<unknown>;
  sweepExpiredAgentClarificationPayloads(): Promise<unknown>;
}

/** Strict mapper around service-role RPCs; malformed persistence fails closed. */
export class SupabaseAgentClarificationRepository
  implements AgentClarificationRepository
{
  constructor(private readonly client: AgentClarificationRpcClient) {}

  async grantOriginator(input: Parameters<AgentClarificationRepository["grantOriginator"]>[0]) {
    return grantOutcomeSchema.parse(await this.client.grantAgentDialogueOriginator(input));
  }

  async revokeOriginator(input: Parameters<AgentClarificationRepository["revokeOriginator"]>[0]) {
    return revokeOutcomeSchema.parse(await this.client.revokeAgentDialogueOriginator(input));
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

  async reconcileDriving(
    input: Parameters<AgentClarificationRepository["reconcileDriving"]>[0],
  ) {
    return z
      .number()
      .int()
      .min(0)
      .parse(await this.client.reconcileRunningAgentClarifications(input));
  }

  async sweepExpiredPayloads() {
    return z
      .number()
      .int()
      .min(0)
      .parse(await this.client.sweepExpiredAgentClarificationPayloads());
  }
}
