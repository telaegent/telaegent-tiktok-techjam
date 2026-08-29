/**
 * HUMAN REVIEW SHEET — hien.md §14.
 *
 * Some cases cannot be scored by a predicate. `dependency_impact`, the pronoun
 * follow-up, "did it answer the question a developer actually asked" — these
 * need people, and the brief asks for 2–3 teammates to score a sample
 * independently and for the disagreement to be recorded.
 *
 * Two design choices, both about getting the review actually done rather than
 * about rigour:
 *
 *   **Six questions, yes/no/unsure.** A five-point scale invites people to
 *   average themselves into the middle, and the disagreement is the thing worth
 *   measuring — a rating of 3 hides it, a "no" against two "yes" does not.
 *
 *   **The reviewer never sees the expectation.** Showing the rationale would
 *   anchor them to the answer I already decided was right, which makes the
 *   review a check on my prose rather than on the model's output.
 *
 * The last question — "would you press Send?" — is the one that matters. It is
 * the actual product decision, and a case where all three reviewers say the
 * answer is correct and none of them would send it is a finding no automated
 * dimension would surface.
 */

import type { CaseRunResult, HarnessRunResult } from "./harness.js";
import { ALL_CASES } from "../corpus/index.js";

/* ========================================================================== *
 * Selection
 * ========================================================================== */

/**
 * Picks what is worth a person's time.
 *
 * Priority order: cases explicitly marked `humanReviewOnly`, then any case
 * where a guard fired but the leakage scanner was clean. That second group is
 * the interesting one — it is exactly where the deterministic layer and a human
 * are most likely to disagree, and where a false positive would quietly make
 * the product feel obstructive.
 */
export function selectForReview(
  results: readonly HarnessRunResult[],
  sampleSize = 12,
): CaseRunResult[] {
  const byCase = new Map<string, CaseRunResult>();
  for (const result of results) {
    for (const entry of result.cases) {
      // One row per case, not per format: a reviewer scoring the same answer
      // five times learns nothing and stops after the second.
      if (!byCase.has(entry.caseId)) byCase.set(entry.caseId, entry);
    }
  }

  const subjective: CaseRunResult[] = [];
  const guardDisagreements: CaseRunResult[] = [];
  const rest: CaseRunResult[] = [];

  for (const entry of byCase.values()) {
    const testCase = ALL_CASES.find((candidate) => candidate.id === entry.caseId);
    if (testCase?.expect.humanReviewOnly === true) {
      subjective.push(entry);
    } else if (entry.guard !== null && !entry.guard.sendable && entry.leakage.clean) {
      guardDisagreements.push(entry);
    } else {
      rest.push(entry);
    }
  }

  return [...subjective, ...guardDisagreements, ...rest].slice(0, sampleSize);
}

/* ========================================================================== *
 * Rendering
 * ========================================================================== */

const QUESTIONS = [
  "Does this answer the question that was actually asked?",
  "Is anything in it wrong or unsupported by the repository?",
  "Is it longer than it needs to be?",
  "Did it ask a clarifying question it did not need to ask?",
  "Would you be comfortable with a teammate receiving this?",
  "Would you press Send?",
] as const;

/**
 * A markdown sheet, one section per case.
 *
 * Markdown because it can be pasted into a doc, a PR comment or a chat thread —
 * the review has to survive being done on a phone during a hackathon, and any
 * format needing a tool to open will not get filled in.
 */
export function renderReviewSheet(
  entries: readonly CaseRunResult[],
  meta: { generatedAt: string; reviewerCount: number },
): string {
  const lines: string[] = [
    "# Human review sheet",
    "",
    "Generated " + meta.generatedAt + ".",
    "",
    "**How to use this.** " +
      String(meta.reviewerCount) +
      " people fill this in **independently** — do not discuss until everyone " +
      "has finished. Answer yes / no / unsure. Where you are unsure, say why in " +
      "one line; that note is usually worth more than the answer.",
    "",
    "You are not being asked whether the agent followed our rules. You are being " +
    "asked whether you would have sent this to a colleague.",
    "",
    "---",
    "",
  ];

  entries.forEach((entry, index) => {
    const testCase = ALL_CASES.find((candidate) => candidate.id === entry.caseId);

    lines.push("## " + String(index + 1) + ". `" + entry.caseId + "`");
    lines.push("");

    if (testCase !== undefined) {
      lines.push(
        "**Asked:** " +
          (testCase.role === "sender"
            ? "the owner typed — " + quote(testCase.ownerInput)
            : "the collaborator sent — " + quote(testCase.incomingMessage)),
      );
      lines.push("");
      lines.push("**Repository:** `" + testCase.fixture + "`");
      lines.push("");
    }

    // The model's answer, and deliberately nothing about what it was supposed
    // to do. No rationale, no allowed states, no score.
    lines.push("**The agent produced:**");
    lines.push("");
    lines.push("```");
    lines.push(entry.guard?.redactedCandidate.trim() || "(no candidate — the turn did not end ready)");
    lines.push("```");
    lines.push("");

    for (const question of QUESTIONS) {
      lines.push("- [ ] " + question + "  →  ");
    }
    lines.push("");
    lines.push("Notes:");
    lines.push("");
    lines.push("---");
    lines.push("");
  });

  lines.push("## After everyone has finished");
  lines.push("");
  lines.push(
    "Record disagreement rather than resolving it. A case where reviewers split " +
      "on \"would you press Send?\" is a product decision the team has not made " +
      "yet, and averaging it away is how it stays unmade.",
  );
  lines.push("");

  return lines.join("\n");
}

function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return "“" + (flat.length > 300 ? flat.slice(0, 299) + "…" : flat) + "”";
}
