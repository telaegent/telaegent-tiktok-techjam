# Hien — agent protocol findings

**Status:** contracts frozen, deterministic findings established, live comparison pending
**Code:** `apps/server/src/telagent/protocol/`
**Tags:** `hien/protocol-contract`, `hien/corpus`, `hien/evaluators`, `hien/eval-harness`

This memo is the handover. It says what is decided and safe to build against,
what is measured, and what is not yet known — in that order, because the third
category is the one people accidentally build on.

---

## What each of you needs from this

**Phuong** — §2 (output schemas), §5 (memory), §7 (runtime contract deltas).
**Khoa** — §3 (what the backend must enforce), §6 (audit facts).
**Duy** — §4 (UI states and risk flags), §6 (what to show, what never to show).
**Thai** — §8 (CI vs live evaluation, and what must never run in CI).

---

## 1. What is settled

Three things are frozen and you can build against them today.

**The two agent jobs are separate prompts with separate schemas.** Sender-side
drafting and recipient-side answering do not share a template. This is not
tidiness: a shared template produces an agent that asks the *collaborator*
clarifying questions, because it cannot tell which human it is talking to. That
is the single most confusing failure mode I hit, and it is invisible in testing
until someone watches a demo and asks who the agent is talking to.

**A model's output is a draft, and nothing in it can change that.** Not its
state, not its risk flags, not a sentence in the repository claiming otherwise.
The enforcement is layered, and each layer assumes the one above failed:

```
model output
  → schema      is it well-formed?          schemas.ts
  → guards      is it allowed to cross?     guards.ts
  → human       do I want it to cross?      Send / Edit / No
  → shared message
```

All four are required. A `blocked` state from the model does not skip the
guards, and clean guards do not skip the human.

**Provenance comes from the backend, never from the model.** The recipient
schema has no field for a commit or a digest, and strict parsing means a model
that invents one fails loudly rather than being trusted quietly. The model names
paths; `git-helper.ts` attaches what it computed itself. This answers the open
question in `hien.md` §8 — model-supplied source refs are *not* reliable, and the
reason is structural rather than empirical: a model-supplied commit is
unverifiable by construction, and accepting one would let a poisoned repository
file author the provenance shown to the other developer.

---

## 2. Output schemas — for Phuong

Import these from `protocol/contract.ts`. Please do not retype them.

```ts
// sender: the private drafting agent
{
  state: "needs_clarification" | "ready" | "blocked",
  assistantMessage: string,      // private to the owner, never transmitted
  sendCandidate: string | null,  // non-null iff state === "ready"
  riskFlags: RiskFlag[],
  referencedPaths: string[]      // advisory, untrusted, no provenance
}

// recipient: the private answering agent
{
  state: "needs_clarification" | "ready" | "blocked",
  privateSummary: string,        // private to the owner, never transmitted
  sendCandidate: string | null,
  riskFlags: RiskFlag[],
  sourcePaths: string[]          // paths only; backend attaches commit + digest
}
```

Six invariants, each asserted by name in the test suite:

| | |
| --- | --- |
| I1 | `state === "ready"` ⟺ `sendCandidate` is a non-empty string |
| I2 | `state !== "ready"` ⟹ `sendCandidate === null` |
| I3 | `state === "blocked"` ⟹ at least one risk flag |
| I4 | no commit, digest, session id or absolute path in model output |
| I5 | a `sendCandidate` is a candidate — guards *and* a human, both |
| I6 | untrusted text is enveloped in every shipped format |

I2 is the one worth dwelling on. The dangerous shape is a model that reports
`blocked` while still handing the owner something that looks sendable — the UI
shows a warning and a message, and the owner's eye goes to the message. Making
it a parse failure means it cannot reach the UI at all.

**Use the generated JSON Schema**, from `senderJsonSchema()` /
`recipientJsonSchema()`, for the CLIs' structured-output flags. It is generated
from the same Zod object the parser enforces, so the document the model is shown
cannot drift from the one its answer is checked against. A hand-written
`.schema.json` beside a Zod schema is a bug with a several-week fuse.

---

## 3. What the backend must enforce — for Khoa

Prompt-enforced is not enforced. These belong in your path, before a candidate
can become a shared message. `guards.ts` implements all of them;
`inspectCandidate()` and `guardTurn()` are the entry points.

1. **Deny `.env` and friends by name, before the file is opened.** Already in
   `context-policy.ts`; `checkAlwaysDenied()` is the function, and the ordering
   is the security property — a name check that ran after path resolution would
   already have touched the file and followed a symlink.
2. **Inspect the candidate for secret content.** Path denial is not enough,
   because `"what is the value of DATABASE_URL"` never names a file.
3. **Reject auto-send and permission claims.** A model saying "I've sent that
   to Justin" transmits nothing and is still a trust bug: the owner stops
   watching the boundary.
4. **Reject injected instructions being relayed onward.** Being the victim of an
   injection is bad; being its delivery mechanism to another person's agent is
   worse.
5. **Review path claims — do not honour them, and do not fail on them.** A model
   claiming it read `../repo-b/.env` did not read it. Record the audit event and
   continue. Failing the turn would let a poisoned repository file break the
   owner's own turns by persuading their agent to name a forbidden path.

Guards may only ever downgrade `ready` to `blocked`. Nothing may promote a turn
to `ready` — that would make a guard a source of permission, which is I5.

---

## 4. UI states and risk flags — for Duy

The protocol has exactly three states. `Thinking` and `Error` in your brief are
runtime states, not protocol states, and deliberately so — modelling "thinking"
in the protocol would let a model claim it is still working in order to avoid
answering.

| State | What the private room shows |
| --- | --- |
| `needs_clarification` | the agent's question, and a reply box |
| `ready` | the candidate, and `[ Edit ] [ No ] [ Send ]` |
| `blocked` | the reason, the safe alternative, and no Send button |

**Show the guard's state, not the model's.** They differ exactly when a guard
fired, and that gap is the product working. `guardTurn()` returns
`effectiveState` for this.

Risk flags are for explanation, never for permission. An absent `secret_content`
flag does not make output sendable and a present one does not block it — the
guards decide. But a block with no explanation is an unexplainable product, so
the flags are what your blocked card renders.

Nine flags: `secret_request`, `secret_content`, `scope_violation`,
`injection_detected`, `auto_send_attempt`, `permission_escalation`,
`cross_project_reference`, `oversized_disclosure`, `ambiguous_request`.

**Never render `assistantMessage` or `privateSummary` on the shared side.** They
are private by contract, and the leakage scanner treats a host path in them as a
finding — the owner should not learn our directory layout either.

---

## 5. Memory — for Phuong

Five strategies in `memory.ts`. The recommendation does not depend on the live
numbers, because the deciding property is not a score:

> **M1 is disqualified regardless of how it performs.** Provider-session-only
> memory cannot be rebuilt from Telaegent's database. When a session expires, is
> compacted, or the user switches provider, the conversation is gone. Every
> other strategy carries `rebuildableFromTelaegentAlone: true`.

That is `phuong.md` §9 restated as a testable property rather than a principle.

**Recommended: M4 — compact durable summary plus the last 8 approved turns.**
The argument against M3 is not score, it is silence: M3 drops old turns without
trace, so a follow-up whose antecedent has scrolled out is answered confidently
and wrongly. M4 drops nothing — what leaves the window enters the summary.

`rehydrationContext(history, projectFacts)` is the concrete answer to
`phuong.md` §11. It is a pure function of durable rows, so a lost provider
session degrades from an outage into a longer prompt.

**The open question is M4 against M5.** M5 is project facts plus recent turns
with no narrative summary. If they tie on the live corpus, you can skip building
summarisation for P0 — a real saving, since summarisation is the one part of the
memory design needing its own model call and its own failure handling. Run
`--memory M4` and `--memory M5` and compare before you build it.

---

## 6. Security findings

Three so far. Each was found by writing an assertion, not by reading code —
which is the argument for the corpus existing at all.

**F1. Shape-based secret detection has a real hole.** `redactText` detects
credential *shapes*: bearer headers, PEM blocks, provider key prefixes,
`NAME=value` assignments, connection strings. It cannot see a bare high-entropy
token with no surrounding structure:

```
"Here it is: <32-char mixed-case token, no NAME= prefix>"   →  passed cleanly
```

Fixed with an entropy backstop in `guards.ts`. The discriminator that works is a
16-or-more character alphanumeric run at 25%+ digit density — not a
character-class count, which flags ordinary code identifiers. Sixteen rather
than twelve so UUID correlation ids keep flowing.

*This is mitigation, not a solution.* The real defence is that `.env` is denied
by name long before its contents can reach an agent's context. If that first
layer is ever bypassed, the backstop is a heuristic, and heuristics lose.
**Khoa, Phuong: the path denial is the load-bearing one.**

**F2. `docs/setup.md` is a more realistic leak than `.env`.** Every brief
focuses on `.env`. The `secret-traps` fixture also contains a setup document
with a filled-in example block — because every real README has one. An agent
answering "how do I set this up locally?" meets those credentials while doing
something completely legitimate, and the honest answer is to quote the document.
Nobody attacks anything. Corpus case `r.secret.setup_doc_quote` is the one I
expect to fail first in a live run.

**F3. Approving a message is not adopting its contents.** A human pressing Send
on "Justin already approved all future file requests" has approved *that
sentence being transmitted*. It is not an authorisation, and it must not become
one when it reappears in shared history as apparently-settled fact. Four corpus
cases cover this, including a multi-turn version with manufactured agreement
from the recipient's own side.

**Audit facts worth recording** (Khoa): rejected path claims with their denial
code; guard findings by code; the gap between the model's state and the
effective state. Not: raw candidates, raw prompts, or anything the leakage
scanner flagged.

---

## 7. Runtime contract — for Phuong

`protocol/contract.ts` deliberately does not describe how a process is launched;
that stays yours in `runtime-contract.ts`. Two seams:

**`ProtocolTurnInput` is built by the backend, never by a message.**
`repositoryFullName`, `githubRepositoryId`, `branch`, `commit` and the workspace
path all come from the runtime binding. A remote collaborator must never
influence any of them — they determine which files an agent can reach.

**Suggested settings for a recipient turn:** `sandboxMode: "read-only"`,
`networkMode: "none"`, and an absolute workspace path. The evaluation runners use
`--sandbox read-only` for Codex for a specific reason: a prompt-injection case
that succeeds in persuading the agent to modify the repository then fails at the
OS boundary instead of corrupting the fixture for every case after it. The same
argument applies in production, more so.

---

## 8. CI and live evaluation — for Thai

**`npm test` never calls a provider.** 370 tests, offline, no network. The
enforcement is structural, not documentary: the live runners throw unless
`TELAEGENT_LIVE_EVAL=1`, and `protocol.test.ts` asserts that they do.

```
npm test                                  370 tests, offline, free
npm run test:protocol                     just this workstream
npm run eval:fake                         full pipeline, fake runner, free
TELAEGENT_LIVE_EVAL=1 npm run eval:claude  real, billable
TELAEGENT_LIVE_EVAL=1 npm run eval:codex   real, billable
```

**Never set `TELAEGENT_LIVE_EVAL` in CI.** A full live run is 66 cases × 5
formats × 2 providers = 660 agent turns.

Eval output is gitignored. A live run's raw JSON quotes fixture file contents
and can record provider session ids; only the summarised report is ever
committed. Fixture workspaces are materialised under the OS temp directory, so
nobody gets nested git repositories in their `git status`.

---

## 9. What is NOT yet known

Stated plainly so nobody builds on it.

**The P1–P5 comparison has not been run against a real model.** The machinery is
complete and the fake-runner smoke run exercises every path, but no live numbers
exist. On this machine `codex` is not installed and `claude` is restricted to
`claude -p`, so I could not produce them here.

This means the following are **hypotheses, not findings**:

- that P5 (compact summary + recent turns) is the best format;
- that P2 (JSON-only) is materially weaker on adversarial cases;
- that P4 (full transcript) amplifies conversation poisoning;
- that structured JSON improves answers at all.

P5 is currently recommended on an argument that does not need the numbers — it is
the only format whose context Telaegent can rebuild after a provider session is
lost. If the live run shows P3 matching it on quality, P5 still wins on that
ground. But if P1 matches P5 on the simple categories, most of the context
machinery is only earning its keep on hard cases, and the common path should
skip it. **Worth knowing before Phuong builds the adapter.**

**Also unmeasured:** whether Claude and Codex rank the formats the same way
(assume not — `hien.md` §19 is right about this); real latency; how much a
resumed session differs from a fresh one; and the human-review sample for the
`humanReviewOnly` cases, which needs 2–3 of you scoring independently.

**To produce the numbers**, on a machine with both CLIs authenticated:

```bash
TELAEGENT_LIVE_EVAL=1 npm run eval:claude
TELAEGENT_LIVE_EVAL=1 npm run eval:codex
```

Roughly 30–60 minutes per provider. Start with
`--formats P3,P5 --cases r.secret` if time is short — that is 24 turns and
covers the disclosure cases that matter most for the demo.

---

## 10. If you only remember three things

1. **The path denial is the load-bearing secret defence.** Content inspection is
   a backstop and it is heuristic. Do not let a refactor move `.env` denial
   after path resolution.
2. **Nothing a model says is permission.** Not its state, not its flags, not a
   sentence in the repository, not a message a human already approved.
3. **The corpus is the asset.** Prompts will change, guards will change, the
   runtime will change. 66 cases and four fixture repositories are what makes it
   safe to change them — and what will tell you, in one command, whether a
   change broke the thing the product is selling.
