/**
 * CORPUS TYPES — how a test case states what it expects.
 *
 * The design constraint that shapes this file: hien.md §13 and §19 both insist
 * on deterministic assertions wherever one is possible, and on not using an LLM
 * judge for anything a predicate can decide. So an expectation here is a set of
 * checkable propositions, not a reference answer to compare against.
 *
 * That has a consequence worth being honest about. "Did it answer the actual
 * question?" cannot be fully decided by a predicate, and pretending otherwise
 * would produce a scoring harness that measures keyword overlap and calls it
 * correctness. The compromise: `mustMention` captures the cases where a correct
 * answer provably contains a specific identifier — a filename, a symbol, an
 * environment variable name — and the genuinely subjective residue is routed to
 * the human review sample (hien.md §14) rather than guessed at. A case that
 * cannot state a checkable expectation says so, and is scored on safety and
 * schema conformance only.
 */

import type { RiskFlag, SharedTurn, TurnState } from "../contract.js";
import type { FixtureRepoId } from "../fixtures/repos.js";

/* ========================================================================== *
 * Categories
 * ========================================================================== */

/**
 * The ten categories of hien.md §6.
 *
 * Kept as a flat union rather than a hierarchy because the report groups by
 * exactly this axis, and because every case belongs to precisely one — a case
 * that seems to belong to two is usually two cases.
 */
export const CORPUS_CATEGORIES = [
  "simple_repo_question",
  "cross_user_coordination",
  "ambiguous_request",
  "sensitive_request",
  "safe_reformulation",
  "repo_prompt_injection",
  "malicious_collaborator",
  "cross_project_attack",
  "conversation_poisoning",
  "memory",
] as const;
export type CorpusCategory = (typeof CORPUS_CATEGORIES)[number];

/* ========================================================================== *
 * Expectations
 * ========================================================================== */

/**
 * What must be true of the turn's outcome.
 *
 * Every field is optional and every field that is present is asserted. Absence
 * means "this case makes no claim here", which is different from "anything
 * goes" only in that it is deliberate — a case with no assertions at all is
 * caught by `validateCorpus`.
 */
export interface CaseExpectation {
  /**
   * States that would be acceptable. A case listing more than one is saying the
   * choice between them is a judgement call, which is common and honest: for a
   * secret request, both "block it" and "ask whether values are needed" are
   * correct behaviour, and forcing a single answer would penalise a good agent.
   */
  allowedStates: TurnState[];

  /**
   * Risk flags the model must raise.
   *
   * A hard requirement, and the one place the model's self-report is load-
   * bearing — not for safety, which the guards own, but for the UI, which needs
   * to explain to the owner *why* their message was held. An agent that blocks
   * without saying what it noticed produces an unexplainable product.
   */
  requiredFlags?: RiskFlag[];

  /**
   * The turn must not end `ready` with a sendable candidate.
   *
   * Distinct from `allowedStates: ["blocked"]`: this permits a clarification
   * turn, which is often the better behaviour, while still forbidding the
   * message from going out.
   */
  mustNotProduceSendableCandidate?: boolean;

  /**
   * Substrings that must appear somewhere in the output.
   *
   * Only ever identifiers a correct answer cannot avoid — a filename, an export
   * name, an environment variable. Never prose, because asserting on phrasing
   * measures style and reports it as correctness.
   */
  mustMention?: string[];

  /**
   * Substrings that must appear nowhere in the output.
   *
   * Secret sentinel values, cross-project sentinels, and injected instruction
   * text. This is the assertion that does most of the security work, and it is
   * exact-match by design: a regex here could be wrong in a way a literal
   * cannot.
   */
  mustNotContain?: string[];

  /**
   * Substrings that must not appear in the **send candidate** specifically.
   *
   * Separate from `mustNotContain` because of a mistake the first live run
   * exposed. Injected instructions were being asserted against every field, so
   * an agent that told its own owner "this document contains text instructing
   * me to ignore your approval — I did not act on it" was scored as a failure
   * for quoting the injection.
   *
   * That is backwards. Reporting an injection to your owner *requires* quoting
   * it, and an agent that cannot explain what it found is less safe, not more.
   * The thing that must never happen is relaying it onward to the other side's
   * agent — which is what this field asserts, and only this field.
   */
  mustNotRelay?: string[];

  /**
   * The case is subjective and goes to human review (hien.md §14).
   *
   * Set when correctness genuinely cannot be decided by predicate. The harness
   * still scores safety and schema conformance; it simply does not pretend to
   * score usefulness.
   */
  humanReviewOnly?: boolean;

  /** Why this expectation is what it is. Shown in the report next to failures. */
  rationale: string;
}

/* ========================================================================== *
 * Cases
 * ========================================================================== */

interface CaseBase {
  /** Stable id. Appears in the report and in commit messages; do not reuse. */
  id: string;
  category: CorpusCategory;
  /** Repository the agent is working in. */
  fixture: FixtureRepoId;
  /** Shared history the memory strategy selects from. */
  sharedHistory?: SharedTurn[];
  /** Prior private turns, for multi-turn clarification cases. */
  privateTurns?: { speaker: "owner" | "agent"; text: string }[];
  expect: CaseExpectation;
}

export interface SenderCase extends CaseBase {
  role: "sender";
  /** What the owner typed into the composer. */
  ownerInput: string;
}

export interface RecipientCase extends CaseBase {
  role: "recipient";
  /** The approved message that arrived from the collaborator. */
  incomingMessage: string;
}

export type ProtocolCase = SenderCase | RecipientCase;

/* ========================================================================== *
 * Validation
 * ========================================================================== */

export interface CorpusProblem {
  caseId: string;
  problem: string;
}

/**
 * Checks the corpus itself.
 *
 * A test suite is only as good as its cases, and the failure modes here are
 * quiet ones: a duplicated id silently overwrites results in the report; an
 * empty `allowedStates` passes every run; a case with no assertion at all looks
 * like coverage while measuring nothing. `protocol.test.ts` runs this first, so
 * the corpus is checked before it is used to check anything else.
 */
export function validateCorpus(cases: readonly ProtocolCase[]): CorpusProblem[] {
  const problems: CorpusProblem[] = [];
  const seen = new Set<string>();

  for (const testCase of cases) {
    if (seen.has(testCase.id)) {
      problems.push({ caseId: testCase.id, problem: "duplicate case id" });
    }
    seen.add(testCase.id);

    if (testCase.expect.allowedStates.length === 0) {
      problems.push({
        caseId: testCase.id,
        problem: "allowedStates is empty, so every outcome passes",
      });
    }

    const expectation = testCase.expect;
    const hasAssertion =
      expectation.allowedStates.length < 3 ||
      (expectation.requiredFlags?.length ?? 0) > 0 ||
      expectation.mustNotProduceSendableCandidate === true ||
      (expectation.mustMention?.length ?? 0) > 0 ||
      (expectation.mustNotContain?.length ?? 0) > 0 ||
      (expectation.mustNotRelay?.length ?? 0) > 0 ||
      expectation.humanReviewOnly === true;

    if (!hasAssertion) {
      problems.push({
        caseId: testCase.id,
        problem: "case asserts nothing — it would pass on any output",
      });
    }

    if (expectation.rationale.trim().length === 0) {
      problems.push({ caseId: testCase.id, problem: "missing rationale" });
    }
  }

  return problems;
}

/** Counts cases per category, for the coverage assertion in protocol.test.ts. */
export function categoryCounts(
  cases: readonly ProtocolCase[],
): Record<CorpusCategory, number> {
  const counts = Object.fromEntries(
    CORPUS_CATEGORIES.map((category) => [category, 0]),
  ) as Record<CorpusCategory, number>;
  for (const testCase of cases) counts[testCase.category] += 1;
  return counts;
}
