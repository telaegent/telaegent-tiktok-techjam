/**
 * CORPUS INDEX — every case, plus the coverage floors the suite enforces.
 *
 * hien.md §6 asks for at least 50 meaningful cases and warns against testing
 * five happy examples. The floors below are what stop that from silently
 * happening again: a future change that deletes the adversarial half of the
 * corpus fails `protocol.test.ts` rather than turning the suite green.
 */

import { MEMORY_CASES } from "./memory-cases.js";
import { RECIPIENT_CASES } from "./recipient-cases.js";
import { SENDER_CASES } from "./sender-cases.js";
import {
  categoryCounts,
  validateCorpus,
  type CorpusCategory,
  type ProtocolCase,
} from "./types.js";

export * from "./types.js";
export { SENDER_CASES } from "./sender-cases.js";
export { RECIPIENT_CASES } from "./recipient-cases.js";
export { MEMORY_CASES, PROJECT_CONSTANT } from "./memory-cases.js";

export const ALL_CASES: ProtocolCase[] = [
  ...SENDER_CASES,
  ...RECIPIENT_CASES,
  ...MEMORY_CASES,
];

/**
 * Minimum cases per category.
 *
 * Not uniform, and the shape encodes a judgement about where failures cost
 * most. The adversarial categories carry higher floors than the simple ones
 * because a regression there is a security regression, while a regression in
 * `simple_repo_question` is a quality regression that someone will notice by
 * using the product.
 *
 * `simple_repo_question` still has a floor of eight, for the opposite reason:
 * it is the category that catches over-blocking, and over-blocking is the
 * failure mode that kills a demo without ever looking like a bug.
 */
export const CATEGORY_FLOORS: Readonly<Record<CorpusCategory, number>> = Object.freeze({
  simple_repo_question: 8,
  cross_user_coordination: 6,
  ambiguous_request: 5,
  sensitive_request: 10,
  safe_reformulation: 7,
  repo_prompt_injection: 6,
  malicious_collaborator: 4,
  cross_project_attack: 5,
  conversation_poisoning: 4,
  memory: 8,
});

/**
 * Categories whose floor currently equals their case count.
 *
 * An honest note rather than a mechanism. A floor set to the number of cases
 * that happen to exist only prevents deletion — it does not represent a
 * judgement that the coverage is sufficient. These four are the thinnest parts
 * of the corpus and the first place to add cases:
 *
 *   ambiguous_request       5   the boundary between asking and guessing
 *   repo_prompt_injection   6   only three placements are covered
 *   malicious_collaborator  4   the attack surface is wider than four messages
 *   cross_project_attack    5   depends more on the runtime than on the prompt
 *
 * `memory` was the fifth and worst until it went from 2 to 9; the floor of 8
 * now has real meaning, which is what a floor is for.
 */
export const THIN_CATEGORIES: readonly CorpusCategory[] = Object.freeze([
  "ambiguous_request",
  "repo_prompt_injection",
  "malicious_collaborator",
  "cross_project_attack",
]);

export function corpusProblems(): ReturnType<typeof validateCorpus> {
  return validateCorpus(ALL_CASES);
}

export function corpusCoverage(): Record<CorpusCategory, number> {
  return categoryCounts(ALL_CASES);
}

/** Categories currently below their floor, with the shortfall. */
export function coverageShortfall(): { category: CorpusCategory; have: number; need: number }[] {
  const counts = corpusCoverage();
  return (Object.keys(CATEGORY_FLOORS) as CorpusCategory[])
    .map((category) => ({
      category,
      have: counts[category],
      need: CATEGORY_FLOORS[category],
    }))
    .filter((entry) => entry.have < entry.need);
}

export function casesByCategory(category: CorpusCategory): ProtocolCase[] {
  return ALL_CASES.filter((testCase) => testCase.category === category);
}

export function findCase(id: string): ProtocolCase | undefined {
  return ALL_CASES.find((testCase) => testCase.id === id);
}
