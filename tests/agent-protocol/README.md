# Agent protocol evaluation

Scaffold for the research in [`docs/plan/hien.md`](../../docs/plan/hien.md):
empirically determine what Telaegent should send into Claude Code / Codex so
agents answer the right project question without leaking, overreaching, or
misunderstanding that their output is a draft awaiting human approval.

Directories exist; the corpus, runners and evaluators are Hien's work.

## The split that matters most

```text
deterministic tests          live provider evaluation
─────────────────────        ────────────────────────
run in CI, every push        run manually, costs money
no provider calls            hundreds of real CLI calls
fake runner                  claude / codex runners
assert exact behavior        score against a rubric
```

Normal CI must never require paid provider calls. Keep these separable from
the first commit — retrofitting the split later is painful, and a suite that
costs money to run stops being run.

## Layout

```text
cases/
  sender/        rough user input -> send-ready candidate
  recipient/     approved request -> repo-grounded answer
  adversarial/   injection, poisoning, cross-project, malicious collaborator
  memory/        follow-ups, provider switch, session loss, long conversations
fixtures/
  repos/         purpose-built repos designed to expose failures
  conversations/ shared-history fixtures for memory tests
runners/
  claude.ts      Claude Code CLI
  codex.ts       Codex CLI
  fake.ts        scripted; the only runner CI uses
evaluators/
  correctness.ts grounded answer to the actual question
  leakage.ts     absolute paths, other repos, credentials, raw .env, CoT
  policy.ts      draft-only semantics, scope adherence, no self-authorization
  schema.ts      structured output parses reliably
results/         raw run output, gitignored
```

## Fixture repos to build

Per §11 — `simple-auth`, `multi-module`, `secret-traps`, `prompt-injection`,
`repo-a`, `repo-b`.

**Fake secrets only.** `secret-traps` deliberately contains files shaped like
credentials (`.env`, `credentials.json`, `private-key.pem`) so the guards can
be proven to refuse them. The repo's `.gitignore` already excludes those
patterns globally, so fixture files that must be committed need an explicit
negation — add it deliberately and keep the values obviously fake.

## Two things worth reusing rather than rebuilding

The archived v1 code already solved parts of this. See
[`legacy/README.md`](../../legacy/README.md):

- `legacy/telaegent-v1/testing/` — in-memory filesystem and fake runners. The
  memory-fs exists specifically to assert that a denied path was *never opened*,
  which is exactly the leakage assertion §10 calls for.
- `legacy/telaegent-v1/context-policy.ts` — path authorization covering `.env`,
  traversal, absolute paths, symlink escape and workspace containment. This is
  a strong starting point for the deterministic guards, but read the two known
  bugs in `legacy/README.md` before harvesting it.

## Commands (proposed, not yet wired)

```text
npm test              deterministic only, no provider calls
npm run test:protocol deterministic protocol assertions
npm run eval:claude   live Claude Code evaluation
npm run eval:codex    live Codex evaluation
npm run eval:all      both, full corpus
```

## Scale warning

50 cases × 5 formats × 2 providers × 2 job types is roughly **1,000 live CLI
runs** before memory experiments. Screen all five formats on a ~15-case subset
first, drop to the top two, then run the full corpus only on those. Same
conclusion, a fraction of the cost. §7 forbids cherry-picking favourable
examples; it does not require running every format at full width.
