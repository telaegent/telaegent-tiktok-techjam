import { createHash } from "node:crypto";
import { z } from "zod";
import { RISK_FLAGS } from "../telagent/protocol/contract.js";

/**
 * Plan section 6 budgets. Byte ceilings are authoritative because character
 * counts undercount non-ASCII text, which is exactly the text a bilingual
 * conversation produces.
 */
export const AGENT_CLARIFICATION_LIMITS = Object.freeze({
  /** Automatic questions per task, counting counter-questions. */
  maxQuestions: 2,
  maxQuestionBytes: 500,
  maxAnswerBytes: 1_500,
  /** Whole in-flight transcript replayed into a resumed recipient turn. */
  maxTranscriptBytes: 4_000,
  /** Owner-facing only; never crosses to the peer. */
  maxPrivateExplanationBytes: 2_000,
  /**
   * The approved history rendered into a dialogue capsule.
   *
   * The loader pages at 200 messages, which bounds the row count and nothing
   * else. Without a byte budget the no-tools lane could be handed a larger
   * prompt than the work lane ever gets, for a turn whose entire job is to
   * answer one narrow question.
   */
  maxSharedContextBytes: 64_000,
  maxSharedContextMessageBytes: 8_000,
  /** Evidence hints, never authorization, so a small ceiling is enough. */
  maxSharedBasisMessageIds: 8,
});

export const MAX_AGENT_CLARIFICATION_QUESTIONS =
  AGENT_CLARIFICATION_LIMITS.maxQuestions;

export const CLARIFICATION_REASON_CODES = [
  "ambiguity",
  "contradiction",
  "missing_intent",
] as const;
export type ClarificationReasonCode = (typeof CLARIFICATION_REASON_CODES)[number];

export const HUMAN_REQUIRED_REASONS = [
  "new_authority",
  "private_context",
  "ambiguous",
  "safety",
] as const;
export type HumanRequiredReason = (typeof HUMAN_REQUIRED_REASONS)[number];

/** Character bound is a cheap prefilter; UTF-8 bytes are the real contract. */
function boundedText(maximumBytes: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maximumBytes)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= maximumBytes,
      { message: `Text exceeds ${maximumBytes} UTF-8 bytes` },
    );
}

/**
 * The human answer, bounded where the request arrives rather than where it is
 * stored.
 *
 * The route used to take 2000 characters while the contract and the SQL check
 * take 1500 UTF-8 bytes, so an over-length answer was accepted at the edge and
 * rejected in the database, reaching the person as a generic 409 that reads as
 * "the task moved on". Bilingual conversations hit it first: Vietnamese and CJK
 * text spends two to three bytes a character, so the byte ceiling arrives while
 * the character count still looks small.
 */
export const humanClarificationAnswerSchema = boundedText(
  AGENT_CLARIFICATION_LIMITS.maxAnswerBytes,
);

const sharedBasisMessageIdsSchema = z
  .array(z.string().uuid())
  .max(AGENT_CLARIFICATION_LIMITS.maxSharedBasisMessageIds)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Shared basis message ids must be distinct",
  });

/**
 * Plan section 7.3. One narrow question for the peer's no-tools lane, carrying
 * a closed reason code and message ids the server has already approved.
 */
export const peerClarificationSchema = z.strictObject({
  question: boundedText(AGENT_CLARIFICATION_LIMITS.maxQuestionBytes),
  reasonCode: z.enum(CLARIFICATION_REASON_CODES),
  sharedBasisMessageIds: sharedBasisMessageIdsSchema,
});

const dialogueRiskFlagSchema = z.enum(RISK_FLAGS);

/**
 * Plan section 7.4. No-tools dialogue output: the model reports what it can
 * say, and deterministic orchestration decides whether it may advance the task.
 * There is deliberately no sendCandidate, resource request, or path field.
 */
export const clarificationDialogueOutputSchema = z
  .strictObject({
    outcome: z.enum(["answered", "counter_question", "human_required"]),
    /** Backend-supplied parent question id, echoed back to prove which turn this is. */
    replyToStepId: z.string().uuid(),
    answer: boundedText(AGENT_CLARIFICATION_LIMITS.maxAnswerBytes).nullable(),
    counterQuestion: peerClarificationSchema.nullable(),
    privateExplanation: boundedText(
      AGENT_CLARIFICATION_LIMITS.maxPrivateExplanationBytes,
    ),
    sharedBasisMessageIds: sharedBasisMessageIdsSchema,
    humanRequiredReason: z.enum(HUMAN_REQUIRED_REASONS).nullable(),
    riskFlags: z.array(dialogueRiskFlagSchema).max(RISK_FLAGS.length),
  })
  .superRefine((value, context) => {
    const valid =
      (value.outcome === "answered" &&
        value.answer !== null &&
        value.counterQuestion === null &&
        value.humanRequiredReason === null) ||
      (value.outcome === "counter_question" &&
        value.answer === null &&
        value.counterQuestion !== null &&
        value.humanRequiredReason === null) ||
      (value.outcome === "human_required" &&
        value.answer === null &&
        value.counterQuestion === null &&
        value.humanRequiredReason !== null);
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "Clarification dialogue outcome fields are inconsistent",
      });
    }
  });

/**
 * The document handed to the provider is generated from the schema its answer
 * is parsed with, so the two cannot describe different objects.
 */
export function clarificationDialogueJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(clarificationDialogueOutputSchema, {
    io: "input",
  }) as Record<string, unknown>;
}

export type PeerClarification = z.infer<typeof peerClarificationSchema>;
export type ClarificationDialogueOutput = z.infer<
  typeof clarificationDialogueOutputSchema
>;

/**
 * Plan section 7.3: shared basis ids must all belong to the server-selected
 * approved capsule. They are evidence hints, so an id outside the capsule is
 * dropped rather than failing the exchange; nothing downstream reads it as
 * authority either way.
 */
export function restrictToApprovedBasis<
  T extends { readonly sharedBasisMessageIds: readonly string[] },
>(value: T, approvedMessageIds: ReadonlySet<string>): T {
  return {
    ...value,
    sharedBasisMessageIds: value.sharedBasisMessageIds.filter((id) =>
      approvedMessageIds.has(id),
    ),
  };
}

/**
 * Plan section 6 hash normalization. Line endings first, then NFC, then outer
 * whitespace, so that a repeat differing only in transport shape is still
 * detected as no progress. Case is preserved deliberately.
 */
export function normalizeClarificationText(value: string): string {
  return value.replace(/\r\n/g, "\n").normalize("NFC").trim();
}

export function hashClarificationText(value: string): string {
  return createHash("sha256")
    .update(normalizeClarificationText(value), "utf8")
    .digest("hex");
}
