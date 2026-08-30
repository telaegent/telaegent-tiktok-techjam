# Live evaluation, round 2 — the cases that are not about safety

**Run:** 2026-08-30, Claude Code CLI 2.1.251, 25 cases x P3 and P5, plus the 11
memory cases on M4. 61 live turns.

Round 1 measured the safety corpus and found P3 and P5 indistinguishable. That
was a real result and also an unsatisfying one: it meant the format decision was
still being made on deterministic scores. This round ran the cases where the two
formats had room to differ — simple repository questions, cross-user
coordination, and ambiguous requests.

---

## 1. P5 wins, and now there is a reason to say so

| Format | Cases | Safety | Score | Leaks | Parse fails | Mean tokens |
| --- | --- | --- | --- | --- | --- | --- |
| **P5** | 25 | 100.0% | **0.982** | 0 | 0 | 1,403 |
| P3 | 25 | 100.0% | 0.971 | 0 | 0 | 1,403 |

Identical prompt size, identical safety, no leaks in either. The whole gap is
two cases, and it is the same failure both times:

- `s.simple.test_command` — asked how to run the tests. P3 ended in
  `needs_clarification`.
- `s.coord.branch_diff` — asked what changed on a branch. P3 ended in
  `needs_clarification`.

P5 answered both directly.

**Why this matters more than 0.011 suggests.** An unnecessary clarifying
question is not a small cost in this product. Every turn is human-gated, so a
question the agent did not need to ask spends a round trip of *the user's*
attention before anything is sent. Two such stalls in twenty-five ordinary
requests is a product that feels hesitant.

This is a `clarification_quality` loss, which by the report's own rule is a
prompt problem rather than a guard problem. The honest reading is that P3's
flatter context makes the agent less certain it has enough to answer, and it
resolves that uncertainty by asking. P5 gives it the same facts with enough
structure to know it already has them.

**Recommendation: ship P5.** It was already the default in the runtime adapter;
this is the first evidence that the default was right for a reason rather than
by luck.

---

## 2. A guard that blocked the correct answer

The highest-value finding of the round, and it is a bug in my own code.

Case `r.simple.session_definition` asks what the `Session` interface looks like.
The agent answered correctly:

```
The Session interface has these fields:
- id: string
- userId: string
- refreshTokenHash: string
- consumedAt: number | null
- deviceId: string
```

My `CREDENTIAL_ASSIGNMENT` redaction rule matched `refreshTokenHash: string` —
a field name containing "token", a colon, a value — replaced the word `string`
with `[redacted]`, and marked the draft **unsendable** with
`GUARD_SECRET_VALUE_IN_CANDIDATE`.

Three more cases (`r.simple.rotation`, `r.simple.oauth_exchange`,
`r.coord.dependency_impact`) hit the same rule at signal severity on private
fields.

**Why this is worse than it looks.** A false negative leaks a secret once and
we find out. A false positive like this one blocks the honest answer to "what
are the field names in this interface" — a question a developer will ask
constantly in a repository about authentication. A tool that refuses the normal
case teaches people to route around it, and a security control everyone routes
around protects nothing.

**Fix.** The rule now declines a match when the value is exactly a type keyword
or a union of them (`string`, `number`, `Buffer`, `string|null`, …). The
narrowing is deliberately tiny — no real credential is the literal string
`string`, so nothing previously caught escapes now. `token: stringify` still
redacts, which is pinned by a test, because an allowlist matched loosely would
itself be the smuggling route.

The mechanism is general: a redaction pattern can now decline a match by
returning it unchanged, and `count` only increments when text actually changed.
Previously `count` incremented on match, so a declined match would still have
been reported to the leakage evaluator as a credential-shaped field.

---

## 3. Memory: M4 measured, M5 not

**M4 (recent shared transcript): 1.000 across all 11 memory cases**, no parse
failures, no leaks, mean 1,675 tokens.

**M5 was not measured.** The run returned 0.273 with eight of eleven cases
failing to parse, which looks exactly like a finding about M5 and is not one:
the account hit a rate limit partway through and the CLI was printing a quota
notice on every call. Mean turn duration dropped from 21s to 7s, and one failed
turn took 995ms — a tell, if anyone had been looking at it.

**Those numbers are discarded.** M4-vs-M5 is still open, and the M5 run needs to
be repeated on a fresh quota.

### What that cost, and what changed because of it

The harness recorded `parseFailure: "INVALID_JSON: (root)"` and threw the raw
output away, so the results file could not distinguish "the model wrote prose"
from "the provider refused to answer". The run had to be reproduced by hand to
find out which had happened. Two changes:

- **A failed case now keeps a 400-character redacted excerpt of the raw
  output** (`rawExcerpt`). Enough to tell a rate limit, a CLI usage error and a
  model that ignored the schema apart from each other, without keeping a
  transcript.
- **The report refuses to present scores from a run with a parse failure rate
  above 25%**, printing a warning above the comparison table instead. Replayed
  against the bad M5 run, it now says *"These numbers are not trustworthy."*

This is the second time an instrumentation defect nearly became a finding — the
first round produced five of them. The pattern is consistent enough to state as
a rule: **on this harness, a surprising result is an instrumentation bug until
proven otherwise.**

---

## 4. Still open

- **M5**, on a fresh quota
- **Codex, entirely.** See `hien-codex-eval-handoff.md` — it needs a machine
  with Codex logged in, which mine is not
- **P1, P2, P4 live.** Both lost decisively on the deterministic harness and I
  do not expect live turns to rescue them, but that is an expectation, not a
  measurement
- **Human review.** The sheet is generated on every run; it needs three people
  and twenty minutes each
