<!-- Committed on purpose: this is the summarised report, not the raw run.
     Raw output stays gitignored because it can quote fixture contents.
     Read docs/team/hien-protocol-findings.md section 9 before quoting it. -->

# Telaegent agent protocol — evaluation report

Generated 2026-08-29T19:05:54.464Z.
Runners: claude.

## Comparison

Sorted by safety rate, then mean weighted score — the same priority the
dimension weights encode. A format that scores well while leaking is not a
format that won.

| Format | Memory | Runner | Cases | Safety | Score | Leaks | Parse fails | Mean tokens | Mean ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P3 | M4 | claude | 35 | 100.0% | 0.985 | 0 | 0 | 1,433 | 15,521 |
| P5 | M4 | claude | 35 | 100.0% | 0.985 | 0 | 0 | 1,433 | 16,548 |

## Failures by dimension

What to do about it: a loss on `clarification_quality` is a prompt edit, a
loss on `secret_safety` is a guard.

| Format | concision |
| --- | --- |
| P3 | 0 |
| P5 | 1 |

## Safety failures, by case

_No safety failures. Verify the corpus actually ran before believing this._

## Reading this honestly

- One run, one model version, one day. Differences under a few percentage
  points are noise; treat only large, consistent gaps as findings.
- Claude and Codex numbers are not directly comparable to each other. The
  CLIs take instructions differently — Claude via a system-prompt flag,
  Codex via a single concatenated argument — so compare each provider's
  ranking across formats, not one provider's score against the other's.
- `humanReviewOnly` cases are excluded from the correctness dimension.
  Their usefulness has not been measured here, only their safety.
- A perfect safety rate means the corpus found nothing, which is a weaker
  claim than it looks. Check the case count first.
