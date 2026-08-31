/**
 * REPORT — turns harness results into the comparison table hien.md deliverable
 * B asks for.
 *
 * Markdown rather than JSON as the primary output, because the audience is four
 * teammates reading it once to make a decision, not a dashboard. The raw JSON is
 * written alongside it for reproducibility (deliverable H), but nobody should
 * have to open that to learn which format won.
 *
 * The report is deliberately opinionated about what goes at the top: safety
 * rate before mean score. A format that scores 0.91 with two leaks is worse
 * than one that scores 0.84 with none, and a table sorted by mean score would
 * bury that.
 */

import type { ProtocolFormatId } from "../contract.js";
import { aggregate, type ScoreDimension } from "../evaluators/score.js";
import type { HarnessRunResult } from "./harness.js";

/* ========================================================================== *
 * Per-run summary
 * ========================================================================== */

export interface RunSummary {
  format: ProtocolFormatId;
  memory: string;
  runnerId: string;
  caseCount: number;
  meanWeighted: number;
  safetyRate: number;
  /** Cases whose output did not parse. hien.md §7: "invalid outputs". */
  parseFailures: number;
  /** Mean prompt size, the context-efficiency column. */
  meanTokens: number;
  meanDurationMs: number;
  /** Cases with at least one leakage finding at proof severity. */
  leakingCases: number;
  failureCounts: Partial<Record<ScoreDimension, number>>;
}

export function summarise(result: HarnessRunResult): RunSummary {
  const scores = result.cases.map((entry) => entry.score);
  const stats = aggregate(scores);

  return {
    format: result.format,
    memory: result.memory,
    runnerId: result.runnerId,
    caseCount: result.cases.length,
    meanWeighted: stats.meanWeighted,
    safetyRate: stats.safetyRate,
    parseFailures: result.cases.filter((entry) => entry.parseFailure !== undefined).length,
    meanTokens: mean(result.cases.map((entry) => entry.approximateTokens)),
    meanDurationMs: mean(result.cases.map((entry) => entry.durationMs)),
    leakingCases: result.cases.filter((entry) => !entry.leakage.clean).length,
    failureCounts: stats.failureCounts,
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/* ========================================================================== *
 * Markdown
 * ========================================================================== */

const pct = (value: number): string => (value * 100).toFixed(1) + "%";
const num = (value: number, places = 3): string => value.toFixed(places);

/**
 * The comparison table.
 *
 * Sorted by safety rate first and mean score second, so the ordering encodes
 * the same priority the weights do. A reader who only looks at the first row
 * should still get the right answer.
 */
export function renderComparison(summaries: readonly RunSummary[]): string {
  const sorted = [...summaries].sort(
    (a, b) => b.safetyRate - a.safetyRate || b.meanWeighted - a.meanWeighted,
  );

  const rows = sorted.map((summary) =>
    [
      summary.format,
      summary.memory,
      summary.runnerId,
      String(summary.caseCount),
      pct(summary.safetyRate),
      num(summary.meanWeighted),
      String(summary.leakingCases),
      String(summary.parseFailures),
      Math.round(summary.meanTokens).toLocaleString("en-US"),
      Math.round(summary.meanDurationMs).toLocaleString("en-US"),
    ].join(" | "),
  );

  return [
    "| Format | Memory | Runner | Cases | Safety | Score | Leaks | Parse fails | Mean tokens | Mean ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => "| " + row + " |"),
  ].join("\n");
}

/**
 * Failures grouped by dimension.
 *
 * The actionable half of the report: a format losing on `clarification_quality`
 * needs a prompt edit, while one losing on `secret_safety` needs a guard. The
 * comparison table says which format won; this says what to do about the one
 * that did not.
 */
export function renderFailureBreakdown(summaries: readonly RunSummary[]): string {
  const dimensions = new Set<ScoreDimension>();
  for (const summary of summaries) {
    for (const dimension of Object.keys(summary.failureCounts) as ScoreDimension[]) {
      dimensions.add(dimension);
    }
  }

  if (dimensions.size === 0) return "_No dimension failures recorded._";

  const ordered = [...dimensions].sort();
  const header = ["| Format", ...ordered].join(" | ") + " |";
  const divider = "| --- " + ordered.map(() => "| --- ").join("") + "|";
  const rows = summaries.map(
    (summary) =>
      "| " +
      summary.format +
      " | " +
      ordered.map((dimension) => String(summary.failureCounts[dimension] ?? 0)).join(" | ") +
      " |",
  );

  return [header, divider, ...rows].join("\n");
}

/** Every case that leaked or failed a safety dimension, named. */
export function renderSafetyFailures(results: readonly HarnessRunResult[]): string {
  const lines: string[] = [];

  for (const result of results) {
    for (const entry of result.cases) {
      if (entry.score.safe && entry.leakage.clean) continue;
      const kinds = [...new Set(entry.leakage.findings.map((finding) => finding.kind))];
      lines.push(
        "- `" +
          entry.caseId +
          "` (" +
          entry.format +
          "/" +
          entry.memory +
          ") — failed " +
          (entry.score.failures.join(", ") || "none") +
          (kinds.length > 0 ? "; leakage: " + kinds.join(", ") : ""),
      );
    }
  }

  return lines.length === 0
    ? "_No safety failures. Verify the corpus actually ran before believing this._"
    : lines.join("\n");
}

/**
 * The full document.
 *
 * The closing caveat is not boilerplate. A run of 66 cases against one model
 * version on one day is evidence, not proof, and a report that does not say so
 * invites someone to quote a 0.3% difference as settled six weeks from now.
 */
export function renderReport(
  results: readonly HarnessRunResult[],
  meta: { generatedAt: string; note?: string | undefined },
): string {
  const summaries = results.map(summarise);
  const runners = [...new Set(summaries.map((summary) => summary.runnerId))];

  // Built as a list of blocks rather than filtered lines. An earlier version
  // dropped every empty string to tidy away the absent note, which also removed
  // the blank lines Markdown needs around headings and tables — the document
  // rendered as one paragraph.
  const noteBlock = meta.note === undefined ? [] : [meta.note, ""];

  // A run that mostly failed to parse is not a measurement of anything, and the
  // scores below it are arithmetic on noise. This banner exists because an
  // M4-vs-M5 comparison once came back at 0.273 with eight schema failures and
  // looked exactly like a finding about M5; the real cause was an account rate
  // limit, and every "failed" turn was the CLI printing a quota notice. The
  // numbers were discarded. Nothing but a loud warning would have stopped a
  // tired person from pasting that table into a report.
  const suspect = summaries.filter(
    (summary) => summary.caseCount > 0 && summary.parseFailures / summary.caseCount > 0.25,
  );
  const suspectBlock =
    suspect.length === 0
      ? []
      : [
          "> **These numbers are not trustworthy.**",
          ">",
          "> " +
            suspect
              .map(
                (summary) =>
                  summary.format +
                  "/" +
                  summary.memory +
                  " failed to parse " +
                  String(summary.parseFailures) +
                  " of " +
                  String(summary.caseCount) +
                  " turns",
              )
              .join("; ") +
            ".",
          ">",
          "> A parse failure rate above 25% usually means the provider failed, not",
          "> that the model answered badly - a rate limit, an expired login, a CLI",
          "> upgrade that changed a flag. Read `rawExcerpt` on a failed case in the",
          "> raw JSON before treating any of this as a result about a format or a",
          "> memory strategy.",
          "",
        ];

  return [
    "# Telaegent agent protocol — evaluation report",
    "",
    "Generated " + meta.generatedAt + ".",
    "Runners: " + runners.join(", ") + ".",
    "",
    ...noteBlock,
    ...suspectBlock,
    "## Comparison",
    "",
    "Sorted by safety rate, then mean weighted score — the same priority the",
    "dimension weights encode. A format that scores well while leaking is not a",
    "format that won.",
    "",
    renderComparison(summaries),
    "",
    "## Failures by dimension",
    "",
    "What to do about it: a loss on `clarification_quality` is a prompt edit, a",
    "loss on `secret_safety` is a guard.",
    "",
    renderFailureBreakdown(summaries),
    "",
    "## Safety failures, by case",
    "",
    renderSafetyFailures(results),
    "",
    "## Reading this honestly",
    "",
    "- One run, one model version, one day. Differences under a few percentage",
    "  points are noise; treat only large, consistent gaps as findings.",
    "- Claude and Codex numbers are not directly comparable to each other. The",
    "  CLIs take instructions differently — Claude via a system-prompt flag,",
    "  Codex via a single concatenated argument — so compare each provider's",
    "  ranking across formats, not one provider's score against the other's.",
    "- `humanReviewOnly` cases are excluded from the correctness dimension.",
    "  Their usefulness has not been measured here, only their safety.",
    "- A perfect safety rate means the corpus found nothing, which is a weaker",
    "  claim than it looks. Check the case count first.",
    "",
  ].join("\n");
}
