/**
 * PROTOCOL SCHEMAS — the parse boundary between a model and Telaegent.
 *
 * Everything a provider CLI returns arrives here as `unknown` and leaves as a
 * typed value or a typed failure. Nothing casts. hien.md §19 is explicit that a
 * model's self-report is not proof, and a cast is exactly the act of accepting
 * a self-report as proof.
 *
 * Three properties this file is responsible for:
 *
 *   1. Strictness. Unknown keys are an error, not noise. A model that emits
 *      `"commit": "81ad2e"` must fail loudly, because the alternative is that a
 *      poisoned repository file gets to author the provenance another developer
 *      sees. (Invariant I4.)
 *
 *   2. Cross-field invariants. `state` and `sendCandidate` are checked against
 *      each other, so "ready with nothing to send" and "blocked but here is the
 *      message anyway" are both parse failures rather than runtime surprises.
 *      (Invariants I1–I3.)
 *
 *   3. Failure that is safe to show. A Zod error message can quote the input.
 *      `parseSenderOutput` therefore returns a redacted, bounded issue list —
 *      never the raw value — because Khoa persists parse failures as audit
 *      events and Duy renders them.
 */

import { z } from "zod";

import { redactText } from "../redaction.js";
import {
  PROTOCOL_LIMITS,
  RISK_FLAGS,
  TURN_STATES,
  type RecipientTurnOutput,
  type SenderTurnOutput,
} from "./contract.js";

/* ========================================================================== *
 * Shared field schemas
 * ========================================================================== */

const stateSchema = z.enum(TURN_STATES);
const riskFlagsSchema = z.array(z.enum(RISK_FLAGS)).max(RISK_FLAGS.length);

/**
 * A model-claimed path.
 *
 * Only shape is enforced here — that it is relative, POSIX-ish and bounded.
 * Authorization is NOT enforced here and must not be: `context-policy.ts` owns
 * that decision and owns it alone. A second path validator would eventually
 * disagree with the first, and the disagreement would be a security hole.
 */
const claimedPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), { message: "path contains a NUL byte" })
  .refine((value) => !/^([A-Za-z]:[\\/]|\\\\|\/)/.test(value), {
    message: "path must be workspace-relative",
  });

const sendCandidateSchema = z
  .string()
  .max(PROTOCOL_LIMITS.maxSendCandidateChars)
  .nullable();

/* ========================================================================== *
 * Cross-field invariants
 * ========================================================================== */

/**
 * I1/I2/I3 as a single reusable refinement.
 *
 * Applied with `superRefine` rather than a discriminated union on `state`
 * because the error messages matter: "ready without a sendCandidate" is a
 * prompt bug worth measuring per format, and collapsing it into a generic
 * union mismatch would erase that signal from the evaluation report.
 */
function applyStateInvariants(
  value: { state: string; sendCandidate: string | null; riskFlags: readonly string[] },
  ctx: z.RefinementCtx,
): void {
  const candidate = value.sendCandidate;

  if (value.state === "ready") {
    if (candidate === null || candidate.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["sendCandidate"],
        message: "I1 violated: state is 'ready' but there is no sendCandidate to send.",
      });
    }
  } else if (candidate !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["sendCandidate"],
      message:
        "I2 violated: state is '" +
        value.state +
        "' so sendCandidate must be null. A message that is not ready must not " +
        "be presented to the owner as sendable.",
    });
  }

  if (value.state === "blocked" && value.riskFlags.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["riskFlags"],
      message: "I3 violated: a blocked turn must say what it is blocked on.",
    });
  }
}

/* ========================================================================== *
 * Sender
 * ========================================================================== */

export const senderOutputSchema = z
  .strictObject({
    state: stateSchema,
    assistantMessage: z.string().min(1).max(PROTOCOL_LIMITS.maxPrivateMessageChars),
    sendCandidate: sendCandidateSchema,
    riskFlags: riskFlagsSchema,
    referencedPaths: z.array(claimedPathSchema).max(PROTOCOL_LIMITS.maxReferencedPaths),
  })
  .superRefine(applyStateInvariants);

/* ========================================================================== *
 * Recipient
 * ========================================================================== */

export const recipientOutputSchema = z
  .strictObject({
    state: stateSchema,
    privateSummary: z.string().min(1).max(PROTOCOL_LIMITS.maxPrivateMessageChars),
    sendCandidate: sendCandidateSchema,
    riskFlags: riskFlagsSchema,
    sourcePaths: z.array(claimedPathSchema).max(PROTOCOL_LIMITS.maxReferencedPaths),
  })
  .superRefine(applyStateInvariants);

/* ========================================================================== *
 * Parse results
 * ========================================================================== */

/**
 * Why a parse failed, in a form that is safe to persist and render.
 *
 * `INVALID_JSON` and `SCHEMA_MISMATCH` are separated because they mean
 * different things for the evaluation report: the first is a provider output
 * mode problem (Phuong can fix it with a different CLI flag), the second is a
 * prompt problem (this workstream's problem).
 */
export type ProtocolParseFailureCode =
  | "EMPTY_OUTPUT"
  | "INVALID_JSON"
  | "SCHEMA_MISMATCH";

export interface ProtocolParseIssue {
  path: string;
  message: string;
}

export type ProtocolParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ProtocolParseFailureCode; issues: ProtocolParseIssue[] };

const MAX_ISSUES = 8;

function toIssues(error: z.ZodError): ProtocolParseIssue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.join(".") || "(root)",
    // A Zod message can echo the offending value; redact before it is stored.
    message: redactText(issue.message).value,
  }));
}

/* ========================================================================== *
 * Tolerant JSON extraction
 * ========================================================================== */

/**
 * Pulls the JSON object out of raw CLI output.
 *
 * Deliberately tolerant of two things and nothing else: a ```json fence, and
 * leading or trailing prose. Both are extremely common in practice and neither
 * changes meaning. It is NOT tolerant of trailing commas, single quotes,
 * comments or repaired truncation — a model whose JSON needs repair is a model
 * whose reliability score should reflect that, and "repair then score" would
 * hide exactly the difference between formats this workstream exists to
 * measure (hien.md §7, "invalid outputs").
 *
 * Exported because the evaluation harness reports extraction failure separately
 * from schema failure.
 */
export function extractJsonObject(raw: string): ProtocolParseResult<unknown> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, code: "EMPTY_OUTPUT", issues: [] };
  }

  let text = raw.trim();

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();

  // Fall back to the outermost balanced object when prose surrounds it.
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return {
        ok: false,
        code: "INVALID_JSON",
        issues: [{ path: "(root)", message: "no JSON object found in output" }],
      };
    }
    text = text.slice(start, end + 1);
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_JSON",
      issues: [
        {
          path: "(root)",
          message: redactText(error instanceof Error ? error.message : "unparseable").value,
        },
      ],
    };
  }
}

/* ========================================================================== *
 * Public parsers
 * ========================================================================== */

export function parseSenderOutput(raw: string): ProtocolParseResult<SenderTurnOutput> {
  const extracted = extractJsonObject(raw);
  if (!extracted.ok) return extracted;

  const parsed = senderOutputSchema.safeParse(extracted.value);
  if (!parsed.success) {
    return { ok: false, code: "SCHEMA_MISMATCH", issues: toIssues(parsed.error) };
  }
  return { ok: true, value: parsed.data };
}

export function parseRecipientOutput(raw: string): ProtocolParseResult<RecipientTurnOutput> {
  const extracted = extractJsonObject(raw);
  if (!extracted.ok) return extracted;

  const parsed = recipientOutputSchema.safeParse(extracted.value);
  if (!parsed.success) {
    return { ok: false, code: "SCHEMA_MISMATCH", issues: toIssues(parsed.error) };
  }
  return { ok: true, value: parsed.data };
}

/* ========================================================================== *
 * JSON Schema documents for provider structured-output flags
 * ========================================================================== */

/**
 * Both CLIs accept a JSON Schema to constrain output. Generating it from the
 * Zod schema rather than hand-writing a parallel `.schema.json` is the whole
 * point: the document the model is given and the document the parser enforces
 * cannot drift apart, which is a failure mode that costs an afternoon to
 * diagnose the first time it happens.
 *
 * `io: "input"` is correct here — the model is producing the value the parser
 * will consume, so the model must be shown the pre-refinement input shape.
 */
export function senderJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(senderOutputSchema, { io: "input" }) as Record<string, unknown>;
}

export function recipientJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(recipientOutputSchema, { io: "input" }) as Record<string, unknown>;
}
