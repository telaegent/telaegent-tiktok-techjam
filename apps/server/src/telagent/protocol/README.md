# `protocol/` — agent-to-agent protocol

What Telaegent says to Claude Code and Codex, what shape the answer must take,
and what holds when the answer is wrong.

Findings and recommendations: [`docs/team/hien-protocol-findings.md`](../../../../../docs/team/hien-protocol-findings.md).

## Layout

```
contract.ts        turn states, risk flags, output shapes, the six invariants
schemas.ts         Zod parsers — strict, with named cross-field invariants
guards.ts          deterministic layer beneath human approval
formats.ts         P1–P5, the five context strategies under comparison
memory.ts          M1–M5, plus rehydrationContext() for lost sessions

prompts/
  shared.ts        permission block + untrusted-data envelope
  sender.ts        private drafting agent
  recipient.ts     private answering agent

corpus/            75 cases across ten categories, with coverage floors
fixtures/          four repositories built to expose failure, not success
evaluators/        leakage detection and the 0–2 scoring rubric
eval/              runners, harness, report, CLI

protocol.test.ts   the machinery works        offline
security.test.ts   the properties hold        offline
```

## Running it

```bash
npm test                                   all workspace tests, offline, free
npm run test:protocol                      just this directory
npm run eval:fake                          full pipeline, fake runner, free

TELAEGENT_LIVE_EVAL=1 npm run eval:claude  real, billable
TELAEGENT_LIVE_EVAL=1 npm run eval:codex   real, billable
```

Live runners throw without `TELAEGENT_LIVE_EVAL`. Never set it in CI: a full run
is 660 agent turns.

Useful flags: `--formats P3,P5`, `--memory M5`, `--cases r.secret`, and
`--metadata full|no-revision|repository-only` for metadata ablations.

## Four things to know before changing anything here

**The layers each assume the one above failed.** Schema, then guards, then the
human. A `blocked` state from the model does not skip the guards, and clean
guards do not skip the human.

**Guards may only downgrade.** Nothing may promote a turn to `ready`. A guard
that could would be a source of permission, which is invariant I5.

**Order is the security property in two places.** `.env` is denied by name
before the path is resolved, and before anything is opened — a check that ran
later would already have followed a symlink. And `looksLikeBareSecret()` applies
its exemptions before its detection, so commits and digests survive.

**Fixture secrets are assembled at runtime, never written as literals.** Keeps
them out of `git grep` and out of secret scanners, and gives the leakage scanner
an exact string to match — which cannot false-negative the way a regex can. If
you add a fixture secret, add it to `SECRET_SENTINELS` the same way.

## Adding a case

Put it in `corpus/sender-cases.ts` or `corpus/recipient-cases.ts` with a
`rationale` saying why the expectation is what it is. `validateCorpus()` runs
first in the suite and rejects a duplicate id or a case that asserts nothing.

Assert on identifiers a correct answer cannot avoid — a filename, an export
name, an environment variable. Never on phrasing: that measures style and
reports it as correctness. If correctness is genuinely subjective, mark it
`humanReviewOnly` and it is scored on safety and schema alone.

If you add a should-block case, add a should-proceed one too. A corpus of only
traps produces a prompt tuned to refuse, and an agent that interrogates the user
about an ordinary question is a worse demo than one that occasionally
over-shares.
