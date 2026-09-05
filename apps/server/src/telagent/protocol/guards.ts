/**
 * DETERMINISTIC GUARDS — what the backend enforces regardless of what the model
 * or the human decides.
 *
 * This is the answer to hien.md §16 question 6, "what must be backend-enforced
 * rather than prompt-enforced?", and it is the layer the product plan §12 calls
 * for: human approval is necessary but not sufficient, because a person can
 * accidentally approve something dangerous at 2am during a demo.
 *
 * Where this sits
 * ---------------
 *   model output  →  schemas.ts   (is it well-formed?)
 *                 →  guards.ts    (is it allowed to cross?)      ← here
 *                 →  human        (do I want it to cross?)
 *                 →  shared message
 *
 * Every one of those is required and none substitutes for another. In
 * particular, a `blocked` state from the model does not skip the guards, and a
 * clean guard verdict does not skip the human.
 *
 * Reuse, deliberately
 * -------------------
 * `checkAlwaysDenied` and `redactText` already exist and are already tested
 * against a large case table. A second secret-detector here would eventually
 * disagree with the first, and at a trust boundary a disagreement between two
 * validators is a hole. So this file adds only what is genuinely new to the
 * messaging product: candidate-level inspection, and the auto-send and
 * permission-escalation patterns that had no equivalent in the ContextPack
 * flow.
 */

import { checkAlwaysDenied, normalizeCandidatePath } from "../context-policy.js";
import type { DenialCode } from "../contract.js";
import { redactText } from "../redaction.js";
import {
  PROTOCOL_LIMITS,
  type ProtocolTurnOutput,
  type RiskFlag,
} from "./contract.js";

/* ========================================================================== *
 * Verdict
 * ========================================================================== */

/** Why a candidate may not cross. Extends the shared denial vocabulary. */
export type GuardCode =
  | DenialCode
  | "GUARD_SECRET_VALUE_IN_CANDIDATE"
  | "GUARD_AUTO_SEND_CLAIM"
  | "GUARD_PERMISSION_CLAIM"
  | "GUARD_INJECTION_ECHO"
  | "GUARD_CANDIDATE_TOO_LARGE"
  | "GUARD_EMPTY_CANDIDATE";

export interface GuardFinding {
  code: GuardCode;
  /**
   * Shown to the owner. Must never quote the offending text: this string is
   * persisted as an audit event and rendered in the UI, and quoting a secret in
   * order to explain that it was blocked would defeat the block.
   */
  safeReason: string;
  /** The risk flag this finding implies, for the UI and for scoring. */
  impliedFlag: RiskFlag;
}

export interface GuardVerdict {
  /** True when the candidate may be offered to the human for approval. */
  sendable: boolean;
  findings: GuardFinding[];
  /**
   * The candidate with any residual secret-shaped text redacted.
   *
   * Present even when `sendable` is false, because Duy's blocked-state card
   * shows the owner what their agent produced. Redacted, because a blocked
   * candidate is exactly the text most likely to contain a secret.
   */
  redactedCandidate: string;
  /** Union of model-declared flags and guard-implied flags, deduplicated. */
  effectiveFlags: RiskFlag[];
}

/* ========================================================================== *
 * Pattern sets
 * ========================================================================== */

/**
 * A model claiming it has sent, will send, or has been authorised to send.
 *
 * Worth blocking even though nothing actually transmits: the owner reads "I've
 * shared that with Justin" and stops paying attention. The trust boundary is
 * only as good as the owner's belief about where it is.
 */
const AUTO_SEND_CLAIMS = [
  /\bI(?:'ve| have)\s+(?:sent|shared|forwarded|delivered|transmitted)\b/i,
  /\bsending\s+(?:this|it|the\s+\w+)\s+(?:now|to\s+\w+)/i,
  /\b(?:message|response|answer)\s+(?:has been|was)\s+sent\b/i,
  /\bI(?:'ll| will)\s+send\s+(?:this|it)\s+(?:now|immediately|straight\s?away)\b/i,
  /\bauto[-\s]?send(?:ing)?\s+(?:enabled|this|now)\b/i,
];

/**
 * A model asserting an authorisation.
 *
 * The distinguishing feature of every pattern here is that it makes a *claim
 * about permission state*. A model saying "you may want to approve this" is
 * fine and common; a model saying "this is approved" is asserting a fact only
 * the backend can establish, and if it is echoing a poisoned conversation turn
 * it is asserting a fact that is false.
 */
const PERMISSION_CLAIMS = [
  /\b(?:approval|permission|authorization|authorisation)\s+(?:is\s+)?not\s+(?:required|needed|necessary)\b/i,
  /\b(?:already|pre[-\s]?)(?:approved|authoriz(?:ed)|authoris(?:ed))\b/i,
  /\bI(?:'m| am)\s+authoris?z?ed\s+to\b/i,
  /\bgrant(?:ing|ed)?\s+(?:you|myself|full|all)\s+(?:access|permission)/i,
  /\bno\s+(?:human\s+)?(?:review|approval|confirmation)\s+(?:is\s+)?(?:needed|required)\b/i,
  /\bbypass(?:ing)?\s+(?:the\s+)?(?:approval|review|policy|guard)/i,
];

/**
 * Injection phrasing echoed back into a candidate.
 *
 * Distinct from detecting injection in *input*: the concern here is that an
 * agent which read a poisoned file has quoted the poison into a message that is
 * about to be handed to another agent. That would make Telaegent the delivery
 * mechanism for the attack, which is worse than being its victim.
 *
 * Kept separate from `context-pack-validator.ts`'s list on purpose. That list
 * targets `relay_*` tool syntax and ContextPack fields; this one targets
 * messaging phrasing. Merging them would mean every future addition has to be
 * correct for both surfaces at once.
 */
const INJECTION_ECHOES = [
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+instructions?/i,
  /disregard\s+(?:the\s+)?(?:previous|prior|above|system)/i,
  /\byou\s+are\s+now\s+(?:a|an|the)\b/i,
  /\bnew\s+system\s+prompt\b/i,
  /reveal\s+(?:your|the)\s+(?:system\s+prompt|instructions|reasoning)/i,
  /\bignore\s+(?:your\s+)?owner(?:'s)?\s+approval\b/i,
  /\bsend\s+(?:me\s+)?(?:every|all)\s+(?:file|environment\s+variable|secret)/i,
  /<\s*\/?\s*(?:system|assistant|tool_call)\s*>/i,
];

/* ========================================================================== *
 * High-entropy tokens
 * ========================================================================== */

/**
 * A finding from the corpus, encoded as code.
 *
 * `redactText` detects credential *shapes*: bearer headers, PEM blocks,
 * provider key prefixes, `NAME=value` assignments, connection strings. Every
 * one of those has a recognisable structure. It does not — and by construction
 * cannot — detect a bare high-entropy string presented without any of them:
 *
 *     "Here it is: <32-char mixed-case token with no NAME= prefix>"
 *
 * That is a real gap, and the security suite found it rather than the design
 * anticipating it. Two things follow.
 *
 * First, the mitigation is layered rather than clever: `.env` is denied by name
 * before it is ever opened, so in the intended flow the value never reaches an
 * agent's context to be quoted. Content inspection is the second line, not the
 * first, and this function is explicitly a backstop.
 *
 * Second, the backstop has to accept false positives to be worth anything, so
 * the exclusions matter more than the detection. Git object ids and content
 * digests are high-entropy, are legitimately shareable, and appear constantly
 * in exactly the answers this product exists to produce — so 7-to-64 character
 * pure-hex tokens are exempt. So are long words and dotted identifiers, which
 * are code.
 *
 * The residue this catches: mixed-class, punctuated, 20-plus-character tokens
 * that are not hex, not an identifier, and not a path. Those are, in practice,
 * secrets.
 */
const HEX_ONLY = /^[0-9a-f]{7,64}$/i;
const PATH_LIKE = /[/\\]/;

/**
 * The positive test: a long unbroken alphanumeric run that mixes letters and
 * digits densely.
 *
 * This, rather than a character-class count, is what separates a secret from an
 * identifier. `getUserById_v2Handler` and `AWS_SECRET_ACCESS_KEY` mix classes
 * too, but their alphanumeric runs are short and word-shaped because a human
 * chose them. `9f4c2ab17e0d5b83` is sixteen unbroken characters at 56% digits
 * because a random number generator chose it, and nothing a person names looks
 * like that.
 *
 * Sixteen is the threshold, chosen against a specific case rather than by
 * taste: a UUID's longest run is twelve, and correlation ids move through these
 * messages legitimately. Raising the bar to sixteen keeps them, while still
 * catching every secret shape in the fixtures.
 */
const DENSE_RUN = /[A-Za-z0-9]{16,}/g;

function hasDenseRandomRun(token: string): boolean {
  DENSE_RUN.lastIndex = 0;
  const runs = token.match(DENSE_RUN);
  if (runs === null) return false;

  for (const run of runs) {
    const digits = (run.match(/[0-9]/g) ?? []).length;
    const letters = (run.match(/[A-Za-z]/g) ?? []).length;
    if (letters === 0) continue;               // a long number is not a secret
    if (digits / run.length < 0.25) continue;  // a long word is not a secret
    return true;
  }
  return false;
}

export function looksLikeBareSecret(token: string): boolean {
  if (token.length < 20 || token.length > 200) return false;

  // Git commits, blob ids, SHA-256 digests. Shareable, and the product needs
  // them: "my answer is based on commit 81ad2e..." must not be blocked.
  if (HEX_ONLY.test(token)) return false;

  // A URL or path. Real ones are shareable; an encoded credential in a query
  // string still carries + or = and falls through to the run test.
  if (PATH_LIKE.test(token) && !/[+=]/.test(token)) return false;

  return hasDenseRandomRun(token);
}

/**
 * Splits on whitespace and quoting, then trims trailing sentence punctuation.
 *
 * The trim is not cosmetic. A commit id at the end of a sentence arrives as
 * "0123...4567." and the trailing full stop stops it matching the pure-hex
 * exemption, so the backstop would block an answer for citing its own source.
 * Only the ends are trimmed — an interior dot is part of `src.auth.session`.
 */
function tokenize(text: string): string[] {
  return text
    .split(/[\s"'`,;()\[\]{}<>]+/)
    .map((token) => token.replace(/^[.!?:]+/, "").replace(/[.!?:]+$/, ""))
    .filter((token) => token.length > 0);
}

/* ========================================================================== *
 * Candidate inspection
 * ========================================================================== */

/**
 * Inspects a proposed outbound message.
 *
 * Order matters and is the security property, in the same way the ordering in
 * `context-policy.ts` is: emptiness and size first (cheap, and a truncated
 * candidate would make later regexes meaningless), then secret content, then
 * claims about sending and permission, then injection echo. Every check runs —
 * this does not short-circuit — because the owner deserves the complete reason
 * their message was blocked, not the first one.
 */
export function inspectCandidate(candidate: string | null): GuardVerdict {
  const findings: GuardFinding[] = [];

  if (candidate === null || candidate.trim().length === 0) {
    return {
      sendable: false,
      findings: [
        {
          code: "GUARD_EMPTY_CANDIDATE",
          safeReason: "There is no message to send.",
          impliedFlag: "ambiguous_request",
        },
      ],
      redactedCandidate: "",
      effectiveFlags: ["ambiguous_request"],
    };
  }

  const redaction = redactText(candidate);

  if (
    candidate.length > PROTOCOL_LIMITS.maxSendCandidateChars ||
    Buffer.byteLength(candidate, "utf8") > PROTOCOL_LIMITS.maxSendCandidateBytes
  ) {
    findings.push({
      code: "GUARD_CANDIDATE_TOO_LARGE",
      safeReason:
        "This draft is longer than a message should be. Ask your agent to " +
        "summarise it rather than sending the whole thing.",
      impliedFlag: "oversized_disclosure",
    });
  } else if (candidate.length > PROTOCOL_LIMITS.oversizedDisclosureChars) {
    findings.push({
      code: "GUARD_CANDIDATE_TOO_LARGE",
      safeReason:
        "This draft discloses a large amount of source. Review it carefully " +
        "before sending, or ask for a summary instead.",
      impliedFlag: "oversized_disclosure",
    });
  }

  if (redaction.count > 0) {
    findings.push({
      code: "GUARD_SECRET_VALUE_IN_CANDIDATE",
      safeReason:
        "This draft contains something shaped like a credential (" +
        redaction.reasons.join(", ").toLowerCase().replace(/_/g, " ") +
        "). Telaegent will not send secret values. Ask for names or structure " +
        "instead.",
      impliedFlag: "secret_content",
    });
  }

  // Backstop for the shape-less case redactText cannot see. Reported under the
  // same code as a shaped secret, because from the owner's point of view it is
  // the same event and a second vocabulary would only be a second thing to
  // explain.
  if (redaction.count === 0 && tokenize(candidate).some(looksLikeBareSecret)) {
    findings.push({
      code: "GUARD_SECRET_VALUE_IN_CANDIDATE",
      safeReason:
        "This draft contains a high-entropy value that looks like a credential. " +
        "Telaegent will not send secret values. Ask for names or structure instead.",
      impliedFlag: "secret_content",
    });
  }

  if (AUTO_SEND_CLAIMS.some((pattern) => pattern.test(candidate))) {
    findings.push({
      code: "GUARD_AUTO_SEND_CLAIM",
      safeReason:
        "The draft claims a message was or will be sent automatically. Nothing " +
        "is sent until you press Send.",
      impliedFlag: "auto_send_attempt",
    });
  }

  if (PERMISSION_CLAIMS.some((pattern) => pattern.test(candidate))) {
    findings.push({
      code: "GUARD_PERMISSION_CLAIM",
      safeReason:
        "The draft asserts an approval that Telaegent did not grant. " +
        "Permission comes from your explicit action, never from message text.",
      impliedFlag: "permission_escalation",
    });
  }

  if (INJECTION_ECHOES.some((pattern) => pattern.test(candidate))) {
    findings.push({
      code: "GUARD_INJECTION_ECHO",
      safeReason:
        "The draft repeats text that tries to instruct the other side's agent. " +
        "Telaegent will not relay that.",
      impliedFlag: "injection_detected",
    });
  }

  return {
    sendable: findings.length === 0,
    findings,
    redactedCandidate: redaction.value,
    effectiveFlags: dedupeFlags(findings.map((finding) => finding.impliedFlag)),
  };
}

/* ========================================================================== *
 * Path claims
 * ========================================================================== */

export interface PathClaimReview {
  /** Claims that normalise cleanly and are not always-denied. */
  accepted: string[];
  /** Claims that were rejected, with the reason. */
  rejected: { path: string; code: GuardCode; safeReason: string }[];
}

/**
 * Reviews the paths a model says it consulted.
 *
 * Note carefully what this does not do: it does not grant access, and it does
 * not stop a turn. Access was decided before the process started, by the
 * workspace the runtime bound. A model claiming it read `../repo-b/.env` did
 * not thereby read it — the claim is either a hallucination or an attempt, and
 * both are audit events rather than errors.
 *
 * Treating a rejected claim as a hard failure would be worse than useless: it
 * would let a poisoned repository file cause the owner's own turns to fail by
 * persuading their agent to name a forbidden path.
 */
export function reviewPathClaims(paths: readonly string[]): PathClaimReview {
  const accepted: string[] = [];
  const rejected: { path: string; code: GuardCode; safeReason: string }[] = [];

  for (const claimed of paths) {
    const normalized = normalizeCandidatePath(claimed);
    if (!normalized.ok) {
      rejected.push({
        path: claimed.slice(0, 200),
        code: normalized.code,
        safeReason: normalized.safeReason,
      });
      continue;
    }
    const denial = checkAlwaysDenied(normalized.value);
    if (denial !== null) {
      rejected.push({
        path: normalized.value,
        code: denial.code,
        safeReason: denial.safeReason,
      });
      continue;
    }
    accepted.push(normalized.value);
  }

  return { accepted, rejected };
}

/* ========================================================================== *
 * Whole-turn guard
 * ========================================================================== */

export interface TurnGuardResult {
  verdict: GuardVerdict;
  pathReview: PathClaimReview;
  /**
   * What the state becomes after guards.
   *
   * A model's `ready` is downgraded to `blocked` when a guard fires. The
   * downgrade only ever moves in that direction: no guard can promote a turn to
   * `ready`, because that would make the guards a source of permission and
   * invariant I5 exists precisely to prevent that.
   */
  effectiveState: "needs_clarification" | "ready" | "blocked";
}

export function guardTurn(output: ProtocolTurnOutput): TurnGuardResult {
  const claimedPaths =
    "referencedPaths" in output ? output.referencedPaths : output.sourcePaths;

  const pathReview = reviewPathClaims(claimedPaths);

  // A turn with nothing to send needs no candidate inspection; inspecting a
  // null candidate would manufacture a spurious "empty" finding on a perfectly
  // ordinary clarification turn.
  if (output.state !== "ready") {
    return {
      verdict: {
        sendable: false,
        findings: [],
        redactedCandidate: "",
        effectiveFlags: dedupeFlags([
          ...output.riskFlags,
          ...pathClaimFlags(pathReview),
        ]),
      },
      pathReview,
      effectiveState: output.state,
    };
  }

  const verdict = inspectCandidate(output.sendCandidate);
  const effectiveFlags = dedupeFlags([
    ...output.riskFlags,
    ...verdict.effectiveFlags,
    ...pathClaimFlags(pathReview),
  ]);

  return {
    verdict: { ...verdict, effectiveFlags },
    pathReview,
    effectiveState: verdict.sendable ? "ready" : "blocked",
  };
}

/**
 * Turns rejected path claims into flags.
 *
 * The split matters, and the first live run is why. Every recipient case was
 * coming back with `scope_violation` — including the ideal ones, where the
 * agent had named `.env` precisely to say it had *not* read it. Naming a
 * forbidden file inside your own workspace is not leaving your scope; it is
 * usually the agent being explicit about what it declined to open.
 *
 * So only a path that actually escapes the workspace counts as a scope
 * violation. A denied-by-name path inside it is a secret reference, and nothing
 * more.
 */
const ESCAPE_CODES = new Set<GuardCode>([
  "FORBID_TRAVERSAL",
  "FORBID_ABSOLUTE_PATH",
  "FORBID_DRIVE_OR_UNC",
  "FORBID_OUTSIDE_WORKSPACE",
  "FORBID_SYMLINK_ESCAPE",
]);

function pathClaimFlags(review: PathClaimReview): RiskFlag[] {
  if (review.rejected.length === 0) return [];
  const flags: RiskFlag[] = [];

  if (review.rejected.some((entry) => ESCAPE_CODES.has(entry.code))) {
    flags.push("scope_violation");
  }
  if (review.rejected.some((entry) => entry.code === "FORBID_TRAVERSAL")) {
    flags.push("cross_project_reference");
  }
  if (
    review.rejected.some(
      (entry) =>
        entry.code === "FORBID_ENV_FILES" ||
        entry.code === "FORBID_SECRET_NAME" ||
        entry.code === "FORBID_PRIVATE_KEY_FILE",
    )
  ) {
    flags.push("secret_request");
  }
  return flags;
}

function dedupeFlags(flags: readonly RiskFlag[]): RiskFlag[] {
  return [...new Set(flags)];
}
