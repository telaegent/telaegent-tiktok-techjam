# Private turn latency: measured, fixed, re-measured

**Owner:** Phuong
**Measured:** 2026-09-05 — baseline, then three rounds of fixes the same day
**Environment:** local Windows development machine, `claude` CLI 2.1.261, Node v24.15.0
**Repository under test:** this repository at `6514779` — 511 tracked files, 312 `.ts`/`.tsx`
**Harness:** `.local/bench/turn-latency.ts` (gitignored; see *Reproducing* below)
**Trials:** one per scenario per round. Single-trial numbers — treat the shape as
real and the decimals as indicative.

## Headline

A private turn cost **83–105 seconds** and two of three scenarios ended in
`RUNTIME_FAILED`. It now costs **22–67 seconds** and all three return a grounded
answer.

| | Simple message | Recipient answer | Sender draft |
| --- | --- | --- | --- |
| Question | "free to pair tomorrow?" | how pairing expiry works | draft a question about TTL |
| **Total, before** | 87.69s | 83.42s | 105.44s |
| **Total, after** | **22.04s** | **67.31s** | **48.80s** |
| Investigation, before | 56.79s — 5 turns / 7 tools | 70.14s — 12 / 22 | 90.07s — 11 / 16 |
| Investigation, after | **7.37s** — 1 / 0 | **36.33s** — 5 / 6 | **33.35s** — 4 / 7 |
| Drafting, before | 30.89s | 13.27s | 15.36s |
| Drafting, after | **14.66s** | **30.97s** | **15.44s** |
| Outcome, before | `needs_clarification` | **`RUNTIME_FAILED`** | **`RUNTIME_FAILED`** |
| Outcome, after | `needs_clarification` | **`ready`, grounded** | **`ready`, grounded** |

**4.0x faster on light traffic, 2.2x on a sender draft, and the two questions
that used to fail now answer.** The recipient question is the one that moved
least on the clock — 83 seconds of failure became 67 seconds of a good answer,
which was the trade on offer.

Answer quality did not pay for the speed. The simple run still declines to commit
Henry to a meeting time and asks which window to offer. The recipient run returns
the TTL default and its 30s–15min constructor bounds, that `index.ts` constructs
the service with no arguments and `.env.example` has no entry for it, the
delete-before-check single-use semantics, that invalid / expired / already-used
all collapse to one `AUTHENTICATION_FAILED` message — the detail most likely to
matter to the UI — and a caveat naming the file it did not open.

## What changed

Eight changes, all inside `apps/server/src/` — Phuong's ownership. No change to
the protocol contract, to any schema ceiling, or to `apps/web/`.

### 1. Let the research pass decline to research — `prompts/investigate.ts`

Rule 1 tells the pass to return an empty note on its first turn when the message
is scheduling, acknowledgement, thanks, or a question about the owner's own
intent, and says explicitly that an empty note is a correct answer rather than a
failure.

**Simple scenario investigation: 56.79s / 5 turns / 7 file reads → 6–7s / 1 turn
/ 0 reads.** One rule, most of the saving on light traffic.

### 2. Take tools away from the drafting pass — `connector-worker.ts`

`toolMode: "none"` on the drafting request, plumbed through `runtime-contract.ts`
and `claude-code-runner.ts` as `--tools ""` plus a full deny list. Claude honours
it; Codex has no equivalent and ignores it.

This closed the original failure cliff. A drafting pass with `Read,Glob,Grep`,
two turns and no research note spends both turns reading and never reaches
structured output, which is exactly how the two `RUNTIME_FAILED` runs died.

### 3. Budget the pass in the unit it can count — `prompts/investigate.ts`

The prompt now says *use at most five tool calls, searches included*.

Turns are the wrong unit. The model cannot see the clock, and the CLI's turn
accounting is not its own — a run capped at three turns was measured emitting
eleven assistant messages. It can count its own tool calls. Told eight it spent
ten; told five it spends six or seven, which is what the deadline can afford.

### 4. Budget the writing too — `prompts/investigate.ts`, `prompts/shared.ts`

The change that finally made the recipient investigation return a note, and it
came from noticing that **these passes are output-bound, not tool-bound.** In the
last failing run the pass finished its reads at 19.6s and then spent forty seconds
generating before the deadline killed it with the note still unsent.

- The note is capped at 1200 characters in the prompt;
  `investigation-note.schema.json` came down from `maxLength: 8000` to `2000` as a
  guardrail above that. Eight thousand characters cost more wall clock to write
  than the reads that earned them.
- Both prompts now forbid writing the answer as prose before emitting the JSON.
  "Reply with one JSON object and nothing else" was not being read as a
  prohibition on preamble.

### 5. Make the two limits agree — `connector-worker.ts`, `connector-turn-executor.ts`

`INVESTIGATION_MAX_TURNS` 12 → 8, `CONNECTOR_INVESTIGATION_DEADLINE_MS` 90s → 60s.
`connectorJobTimeoutMs(300_000)` drops from 420s to 390s accordingly.

Neither limit is a plan; both are backstops, and both are equally bad when they
fire. The turn cap does not let the pass finish the turn it is on — it ends the
run with `error_max_turns` and no structured output, just as the deadline ends it
with no result event at all.

### 6. Stop the drafting pass reasoning at maximum — `runtime-contract.ts`, `connector-worker.ts`

The CLI has an `--effort` flag and we were never passing it, so every pass ran at
maximum. That is right for a pass working something out and wrong for one
transcribing a decision already made: by the time the drafting pass runs, the
files have been read and the findings are in the note.

Measured on the real drafting shape — the repository question, with a populated
1100-character research note, the production argv and `recipient-turn.schema.json`:

| effort | total | thinking tokens | first output token | structured output | turns |
| --- | --- | --- | --- | --- | --- |
| unset (maximum) | 38.62s | 1123 | 21.13s | 4147 chars | 2 |
| `medium` | **23.03s** | 153 | **5.47s** | 4131 chars | 2 |
| `low` | 14.18s | 0 | 3.08s | **2425 chars** | 1 |

Medium is the drafting default (`DRAFTING_EFFORT`). It removes seventeen and a
half seconds of thinking before the first character of the answer and returns the
same answer at the same length — 4131 characters against 4147.

**It cannot halve the pass, and the reason matters more than the flag.** At medium
those 23 seconds are 1.6s of process boot, 1.8s to first event, 2.1s of thinking
and then **17.6s emitting 4131 characters of JSON**. Effort governs thinking only.
Generation is now 76% of a drafting pass and no flag touches it; the only lever on
it is asking for a shorter answer.

**Low is not the same answer faster.** Its structured output came back at 2425
characters against medium's 4131. Part of its speed is that it writes less, so it
trades against how much the owner is told, not just against how long the model
deliberates.

**An earlier version of this document quoted 23.3s / 11.8s / 7.9s here and called
it a halving.** That probe ran the same prompt with an *empty* `<notes>` block.
With nothing to compose from, thinking was nearly the whole pass, so cutting
thinking cut half of it — a true measurement of a stub and a misleading one about
production. The real-path numbers above supersede it, and the harness agrees with
them: recipient drafting went 50.41s → 39.85s across the fix8 → fix9 rounds, about
a fifth, not a half.

**Tried and reverted:** the same flag on the *research* pass. It saved about two
seconds on a thirty-second pass, inside run-to-run variance, and that pass is the
one whose whole job is deciding what to read. Not worth the grounding risk.

### 7. Give the drafting pass one turn of slack — `index.ts`

Policy `maxTurns` 2 → 3.

Two turns is not a budget, it is exactly the cost of success. With no file tools
the pass has one tool it can call, and a successful run already spends two
messages: one that calls StructuredOutput and one that acknowledges it. Anything
that wants a third — a schema retry, a self-correction, a stray paragraph — ends
the run with `error_max_turns` and no structured output, which the runner
classifies as a provider failure and the owner sees as `RUNTIME_FAILED`.

Observed directly: the recipient drafting pass used both of its two turns on
every run, and failed the one time it wanted a third. The connector job schema
still caps this at 3, so the policy moved to the existing ceiling rather than
past it.

### 8. Ask the drafting pass for a shorter answer — `prompts/shared.ts`

The last lever, and the biggest one left after `--effort`: **the answer's own
length**. Generation runs at roughly **4.3 ms per character**, so a 3000-character
object is thirteen seconds no flag can reach.

The contract block used to state the hard ceiling as if it were the budget —
"keep privateSummary under 2000 characters and sendCandidate under 2000" — and the
pass wrote to it. Measured on the repository question: privateSummary 1267,
sendCandidate **1815 against a stated 2000**.

It now states a target well below the ceiling (`DRAFT_PRIVATE_TARGET_CHARS` 900,
`DRAFT_SEND_TARGET_CHARS` 1100), says why in terms the pass can act on — the owner
is watching a blank screen while it types, and every two hundred characters is
about another second of that — and keeps the real limit in a separate line as the
consequence of overshooting rather than as the goal.

**Nothing about the contract changed.** `PROTOCOL_LIMITS` still says 2000, the Zod
parser still enforces 2000, and a turn between the target and the limit is
accepted exactly as before. The turn schemas are generated from those Zod objects
and asserted in sync (`protocol.test.ts`), so tightening them would have been a
protocol change, not a latency fix. This narrows only what the model reaches for.

| | before | after |
| --- | --- | --- |
| Simple drafting pass | 18.51s | **14.66s** |
| Recipient drafting pass | 39.27s | **30.97s** |
| Sender drafting pass | 19.88s | **15.44s** |
| Simple `privateSummary` | 1073 chars | **742** |
| Recipient `privateSummary` | ~1500 chars | **881** |
| Sender `assistantMessage` | 1071 chars | **701** |

**A fifth off every drafting pass, consistently — 21%, 21%, 22%.** Totals moved
less than that because the research pass drifted up in the same round (5.96 →
7.37s, 33.48 → 36.33s, 29.93 → 33.35s) on identical code; that is variance, not a
regression, and it is a fair reminder of how much noise sits in a single trial.

Answer quality held. The recipient run still files `ready`, still names
`connector-pairing.ts`, `index.ts` and `pairing-expiry.ts`, still has the
delete-before-expiry-check single-use semantics, the shared `AUTHENTICATION_FAILED`
with no expired discriminator, the 5-minute default and its 30s–15min clamp, and
still closes with what it could not reach. It says all of it in 881 characters
instead of about 1500.

One test broke, and it was a false positive worth recording.
`delivered-resources.test.ts` bounds how many approved files one prompt may carry
by giving the second file the content `"second"` and asserting the prompt does not
contain it. The new contract sentence contains the word "seconds", so a clamp test
failed because of prose in an unrelated block. Fixed by making the fixture content
a sentinel (`TELAGENT-SECOND-FILE-SENTINEL`) rather than by weakening the
assertion. Suite back to 105 files / 1073 tests.

## Four measurements worth keeping

All run against the CLI directly with the runner's exact argv, not inferred.

### A research pass emits no prose — so there is nothing to salvage

The natural structural fix for "pass 1 ran out of budget" is to recover whatever
assistant text it wrote and hand that to pass 2 as partial findings. It was built,
tested, and then deleted, because the premise is false.

A successful investigation of this repository — 18 assistant messages, 12 tool
calls — emitted **zero characters** of `type: "text"` content. `thinking` blocks
arrive with an empty `thinking` field. The pass speaks only in `tool_use` and its
final StructuredOutput call. Salvage would have been inert at best; at worst it
would have injected forty-character fragments of internal monologue into the
drafting prompt labelled as *findings*, which the drafting pass has no way to
tell apart from something that was read.

Either the research pass returns its own note or the drafting pass has none. That
is why fixes 3 and 4 are prompt changes rather than plumbing.

### The drafting preamble cost ten seconds and reached nobody

One toolless drafting pass, same prompt, before and after the no-preamble rule:

| | before | after |
| --- | --- | --- |
| wall clock | 40.78s | **30.86s** |
| model turns | 3 | 2 |
| assistant prose | 1384 chars | **0** |
| output tokens | 2701 | 1806 |
| thinking tokens | 782 | 784 |
| final structured output | 2653 chars | 2735 chars |

Same answer, same thinking; what vanished was a whole turn spent writing the
answer as prose and then repeating it as JSON. The connector discards every
character of assistant text, so those ten seconds produced output nobody could
ever read.

### Both passes run Opus 5, and a cheaper model did not help

Nothing in this repository pins a model. `CLAUDE_MODEL` is commented out in
`.env.example` and absent from `.env`, so `claudeModel` resolves to `""`,
`ANTHROPIC_MODEL` is never set on the child process
(`claude-code-runner.ts:579`), and the CLI picks its own default. Read off the
CLI's own init event during the measurements above, that default is
**`claude-opus-5`** — for the research pass and the drafting pass alike.

Opus on a pass that is transcribing a note looks like the obvious thing to cut, so
it was measured. Same prompt, same populated note, same schema, `--effort medium`:

| model | total | structured output | thinking tokens | turns | outcome |
| --- | --- | --- | --- | --- | --- |
| `claude-opus-5` | 23.03s | 4131 chars | 153 | 2 | success |
| `claude-sonnet-5` | 33.47s / 18.76s | 2310–5375 chars | 586–906 | 2–4 | **one run hit the turn cap** |
| `claude-haiku-4-5` | 19.55s | 1646 chars | 1498 | 2 | success |

Neither cheaper model is reliably faster on this shape, and both write
substantially less. Haiku finished four seconds ahead of Opus while emitting 60%
less answer and spending *ten times* Opus's thinking tokens at the same effort
setting — the effort flag does not mean the same thing to both. Sonnet's two runs
straddled the turn cap: 33.47s ending in `error_max_turns` on the first, 18.76s
and a valid object on the second.

Two trials per model, so treat the seconds as indicative. The conclusion that
survives is the negative one: **swapping the model is not a free win here**, and
Opus at medium effort is the best point measured. Revisit only with a real trial
count, and against answer quality rather than the clock.

### Where the seconds of a single pass actually go

The generation split of one toolless drafting pass on a scheduling message:

```
 1.7s   process boot -> first byte
13.0s   thinking            910 thinking tokens
 5.7s   emitting the JSON  1078 characters
```

Spawn cost is ~2s of a 20–70s turn and has never been the problem. Thinking was,
until fix 6. What was left after that is the time to write the owner-facing
summary — which is what fix 8 went after, and it is the last line item in a
drafting pass that any change can reach.

## Read this before quoting the failures

**The product did reply, before and after.** The baseline failures were
**conditional, not universal**: they happened when the question was deep enough
that the research pass could not finish inside 12 turns and 90 seconds against a
511-file repository. Two of three scenarios crossed that line; one did not. On a
smaller demo repository the line is crossed less often — which is exactly why
production looked healthy while the benchmark looked alarming.

The honest reading of the baseline was: latency is the certain problem, and the
failure is a cliff that hard questions fall off. That cliff is now closed at three
points — pass 1 usually returns a note, pass 2 survives without one, and pass 2
has a spare turn when it needs one.

## Where to go next

### 1. Publish the progress events that already cross

Unchanged from the baseline report and now the largest remaining win. **6 / 17 /
18** progress events crossed into the transport in the three runs above — file
reads, turn boundaries, activity labels — and every one already survives the
containment check in `connector-worker.ts`. **0 characters reach a browser,
because no SSE route exists.** `runtime-progress-channel.ts` describes an adapter
that authenticates the caller and passes the owner scope to `subscribe`; it was
never built. The browser learns via `AdaptivePoller`
(`apps/web/src/adaptive-poller.ts:20`, 3s floor), so add 0–3s on top of everything
here.

Split ownership: the connector/SSE half is Phuong's, the rendering half is Duy's.
Do not touch `apps/web/`.

**Streaming tokens is still the wrong goal**, and fix 4 made it more wrong: the
drafting pass now emits no prose at all, by design. Codex settles it — it cannot
stream tokens under any circumstances (see *Codex, measured*), so a
token-streaming UI would work on one of our two providers. The substance worth
showing is the activity stream that already crosses, and it crosses on both.

### 2. The recipient question is 67s, and the research pass owns 36 of them

After the output cap, research is now more than half of that turn and the largest
single block anywhere in the report. Every remaining lever there trades against
grounding: five tool calls is already tight enough that the pass names the files
it did not open, and `--effort` does not help it. If 67 seconds is too slow for a
live demo, the realistic options are a smaller demo repository or accepting that
deep questions are slow — not a further squeeze on research. That is a product
call.

### 3. Two cold spawns per turn

Every private turn boots `claude -p` twice, ~2s each. On the simple scenario the
research pass costs 6–7 seconds to conclude it had nothing to research — correct,
but it is now a third of that turn spent deciding not to work. A cheap classifier ahead of
the spawn, or letting the drafting pass make that call itself, would recover most
of it. Untested.

### 4. Re-measure after any of the above

| | baseline | now | next target |
| --- | --- | --- | --- |
| Simple message | 87.69s | **22.04s** | 12–15s |
| Sender draft | fails at 105s | **48.80s** | 40s |
| Repository question | fails at 83s | **67.31s** | 55s |

The drafting pass is now 15–31 seconds and the research pass owns the rest. Every
further second has to come out of research, and every lever there trades against
grounding.

## Codex, measured

The harness takes a provider argument and routes the identical turn through
`CodexRunner` -> `codex exec`. Both providers were run before and after the eight
fixes, same three scenarios, same repository, one trial each.

| | Simple | Recipient answer | Sender draft |
| --- | --- | --- | --- |
| Codex, before | 19.54s | 132.45s | 64.86s |
| **Codex, after** | **18.21s** | **59.21s** | **54.26s** |
| Claude, after | 22.04s | 67.31s | 48.80s |
| Codex outcome, before | `needs_clarification` | `ready` | `ready` |
| Codex outcome, after | `needs_clarification` | `ready` | `ready` |

Four things came out of this, and two of them change how the report should be
read.

### The prompt fixes transfer. That was an assumption; it is now measured.

**The recipient question went 132.45s → 59.21s on Codex — 2.2x, the same shape of
win Claude got.** Investigation 76.67s → 38.01s (6 tool calls → 3), drafting
55.75s → 21.16s (2 → 0).

Only five of the eight fixes can reach a Codex turn — `toolMode`, the `effort`
contract field and `maxTurns` are Claude-only plumbing. The five that do are all
prompt or schema changes, and they carried nearly the whole win. Worth knowing
before writing another fix: **the prompt is the portable surface, the runner
options are not.**

The other two scenarios moved less — 7% on simple, 16% on the sender draft. Both
are inside the run-to-run variance measured on the research pass, so read them as
"no regression", not as wins.

### Codex never had the failure cliff, and the reason is uncomfortable

At baseline, the two scenarios that returned `RUNTIME_FAILED` on Claude both
returned `ready` on Codex. Codex was not better at the question. It was
**unbounded**: `codex exec` has no turn-limit flag, so `INVESTIGATION_MAX_TURNS`
— the budget Claude blew through and failed on — does not bind Codex at all. Only
the investigation deadline and the process timeout do.

So the same repository question that failed Claude at 83 seconds ran Codex to
**132 seconds** and returned an answer. The runner comment already warns that the
two providers are "bounded by different things ... not the symmetry the call site
reads as." This is what that asymmetry looks like from the outside: one provider
fails loudly at a limit, the other quietly takes twice as long. Neither is good,
and the second is harder to notice.

### Codex writes a third as much, so fix 8 does not bind it

| | Claude | Codex |
| --- | --- | --- |
| Simple `privateSummary` | 742 | **157** |
| Recipient `privateSummary` | 881 | **288** |
| Sender `assistantMessage` | 701 | **218** |
| Recipient `sendCandidate` | — | 1164 |
| Sender `sendCandidate` | — | 562 |

The 900 / 1100 targets from fix 8 are already met by a wide margin on every Codex
field but one. The two providers answer the same question at very different
lengths under identical instructions, which is worth remembering if answer
quality is ever judged provider-blind: Codex's recipient answer is grounded and
correct — it names `connector-pairing.ts`, `index.ts`, `pairing-expiry.ts`,
`connector-credentials.ts` and `routes.ts`, has the 5-minute default and the
30s–15min clamp, the collapse of invalid/expired/used into one
`AUTHENTICATION_FAILED`, and its own caveat about what it could not open — in 288
characters of private summary where Claude used 881.

Codex also reaches files differently: it has no native read tool, so its research
shows up as three `command` activities in one model turn, where Claude used six
tool calls across five turns. Different shape, near-identical clock (38.01s vs
36.33s).

### Codex cannot stream tokens at all

On the drafting pass, first streamed character arrives at **20.68s of a 21.16s
pass** (recipient) and 19.63s of 20.39s (sender). That is not slow generation —
`codex exec --json` emits the finished message in one `item.completed` event
rather than incremental deltas.

This settles next-step 1 in one direction: **token streaming is not available on
one of our two providers, by construction.** The activity stream that already
crosses the transport is the only progress signal that works for both. Build that.

### One bug found on the way: `CODEX_HOME` unset does not do what `.env.example` says

The first attempt failed with `RUNTIME_AUTHENTICATION_FAILED`, and took **44
seconds** to say so (~21s per pass, both passes tried).

`.env.example:54` says *"Leave CODEX_HOME unset to reuse the developer's normal
local Codex login."* It does not. `config.ts:20` defaults `CODEX_HOME` to
`path.resolve("codex-home")` — a directory beside the checkout — and
`writeCodexConfig()` creates it with a generated `config.toml` but never an
`auth.json`. The developer's login in `~/.codex` is never consulted. The generated
`config.toml` is not read either: connector turns pass `--ignore-user-config`, so
the only thing that repo-local home can usefully supply is an `auth.json` that
nothing puts there.

On a fresh checkout, following `.env.example` exactly, **every Codex private turn
fails after 44 seconds with an authentication error.** Every measurement above
required `CODEX_HOME=~/.codex`.

Two things to decide, both in the connector area:

1. Make the code and the comment agree — either default `CODEX_HOME` to the
   platform Codex home, or change `.env.example` to say it must be set.
2. Fail fast. `isAvailable()` shells `codex --version`, which passes with no
   credentials at all. An unauthenticated *or out-of-credit* Codex connector looks
   healthy until a turn burns 44 seconds — both failure modes were hit while
   producing this section. In a live demo that is the worst possible place to find
   out.

## Caveats

- One trial per scenario per round. The shape (research dominates on repository
  questions, generation dominates within a pass, spawn cost negligible) is robust;
  the exact seconds are not. Run-to-run variance on the research pass alone was
  33.48s / 33.57s / 39.44s across three runs of identical code.
- Measured against this repository — 511 files, deeply cross-referenced. A smaller
  demo repository will be faster on every round.
- Five of the eight fixes are prompt changes. They are steering, not guarantees:
  the pass told to use five tool calls used six and seven. The turn cap and the
  deadline are what keep the overshoot bounded.
- **One trial per cell.** Both runners, both rounds, all three scenarios — a
  single run each. The research pass drifted several seconds between identical
  runs during this work, so treat anything under ~20% as noise and only the
  large moves as real.
- Five of the eight fixes are prompt or schema changes and reach both runners.
  That they transfer is now measured rather than assumed — see *Codex,
  measured*. The other three are Claude-only plumbing: `toolMode` and the
  `effort` contract field are read only by the Claude runner, and `codex exec`
  has no turn-limit flag for fix 7 to set.
- Codex reasoning is nonetheless already at medium, by a different mechanism and
  for a different reason: `closedToolSurface()` pins
  `model_reasoning_effort="medium"` (`codex-runner.ts:188`) on all four Codex
  paths, because `--ignore-user-config` otherwise drops the effort to `none`.
  That predates this work. The two runners agree on the setting by coincidence,
  not by wiring — the `effort` field on the runtime contract still reaches only
  Claude, so changing it there will silently not move Codex.
- No model is pinned anywhere, so every number here is whatever the CLI defaults
  to on the day — `claude-opus-5` when measured. A CLI update that moves the
  default moves all of this, silently. If these numbers ever need to be
  reproducible, set `CLAUDE_MODEL`.
- The cloud relay, Supabase persistence, and the browser were not in the loop.
  Everything here is connector-local; real end-to-end latency is this plus
  transport plus up to 3s of poll delay.
- All drafting passes ran `sessionMode: "fresh"`, which matches the first message
  of a conversation. Later messages resume the session for pass 2 only — pass 1 is
  `ephemeral` and can never reuse anything.

## Reproducing

The harness drives the real path — `ConnectorWorker` → `ProviderSessionManager` →
`ClaudeCodeRunner` → `claude -p` — against this checkout. Only the cloud transport
(an in-process stub, so every crossing can be timestamped) and the durable context
(hand-built in the shape the Supabase RPC emits) are substituted.

```bash
npx tsx .local/bench/turn-latency.ts simple      # light traffic
npx tsx .local/bench/turn-latency.ts recipient   # deep question
npx tsx .local/bench/turn-latency.ts sender      # deep draft
```

A second argument picks the runner (`claude` is the default). Codex needs a
credential the default `CODEX_HOME` does not provide — see the Codex section:

```bash
CODEX_HOME=~/.codex npx tsx .local/bench/turn-latency.ts simple codex
```

It is scaffolding: it lives under the gitignored `.local/` and must not be
committed. Raw output from the final round is at `.local/bench/run-simple-fix11.log`,
`run-recipient-fix11.log` and `run-sender-fix11.log`; the round before the output
cap is the matching `-fix10` set.

One harness note worth keeping: the stub transport's `poll()` must block like the
real 25s long poll. Returning `null` immediately starves the Node event loop with
microtasks from `watchCancellation`'s re-poll loop, and the provider's stdout is
never read — the run appears to hang with no output at all.
