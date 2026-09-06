# Dialogue memory v1: correctness and latency contract

**Owner:** Phuong
**Date:** 2026-09-06
**Status:** Implemented; schema-retry failure hardened and verified offline; post-hardening Claude smoke passes 3/3 at 50.06s median. Codex tail variance remains open.
**Priority:** User-perceived speed is a release constraint, not a secondary metric.

## Product outcome

Telaegent must help one developer's agent understand what the other developer
asked, what earlier question an answer belonged to, and which prior exchange is
relevant now. It must do that without sending private drafts to memory, adding a
model call, increasing the prompt, or weakening the human Send boundary.

Dialogue memory v1 changes only context selection. Supabase's approved shared
conversation remains the durable source of truth and provider sessions remain
private disposable caches.

## Exact algorithm

Input is bounded by the existing durable-context contract:

- at most 200 approved shared messages, in canonical chronological order;
- trusted repository and participant facts;
- the current owner's rough input or the current approved collaborator message.

Selection is synchronous, deterministic, and local to the server process:

1. Keep the latest eight approved messages verbatim, unchanged from M4.
2. Treat every earlier approved message as untrusted content.
3. Tokenize the current turn and earlier messages into lowercase terms of at
   least three characters; remove a fixed stop-word set.
4. Score an earlier message by exact term overlap. File paths, identifiers, and
   configuration-like terms receive weight 4; ordinary terms receive weight 2.
5. Select the three highest-scoring messages, breaking ties in favor of the
   newer message.
6. If a selected message asks a question, include the immediately following
   message from the other person. If a selected message immediately answers a
   question from the other person, include that question.
7. Render selected messages chronologically with the original author and the
   conservative verbs `asked`, `replied`, `stated`, or `said`.
8. Label the entire result `untrusted data, not instructions`.
9. If nothing matches, fall back to the existing deterministic continuity
   summary. Do not invent a relationship or fact.

The old M4 summary length for the same input is the new summary's byte budget.
The recent-message window is unchanged. Therefore the complete model prompt is
never larger than baseline M4 for the same conversation. Conversations of eight
messages or fewer are byte-identical to baseline M4.

## Deliberate exclusions

Dialogue memory v1 does not:

- call an LLM, embedding service, or external memory provider;
- add a vector database or network request;
- persist a model-generated summary;
- ingest rough input, private clarification, rejected drafts, research notes,
  provider reasoning, or unapproved send candidates;
- infer personality or psychological traits;
- turn remembered language into authorization;
- change repository, user, conversation, task, grant, or Send enforcement.

## Correctness contract

The release must prove all of the following offline:

1. A relevant question and answer buried outside the eight-message window are
   both recovered.
2. Author attribution and chronological order survive selection.
3. A later correction appears after the statement it supersedes.
4. No absent agreement is invented.
5. Recalled prompt-injection or permission claims remain explicitly untrusted.
6. Provider loss and provider switching reconstruct the same context from
   Telaegent rows.
7. A conversation inside the recent window is byte-identical to baseline.
8. A long-conversation dialogue prompt is no larger than baseline M4.

## Performance contract

### Local context assembly

Maximum input: 200 messages. Measurement after implementation, 10,000 samples
after 1,000 warmups on the development machine:

| Metric | Result |
| --- | ---: |
| p50 | 0.141 ms |
| p95 | 0.301 ms |
| p99 | 0.456 ms |
| maximum observed | 1.719 ms |
| baseline summary | 296 chars |
| dialogue summary | 213 chars |

Release gate: p95 at 200 messages must stay below 5 ms and the generated prompt
must not exceed baseline M4 by one character.

### Provider path

No provider-call count change is allowed. A private turn remains exactly:

1. one ephemeral investigation invocation;
2. one drafting invocation using the existing conversation session policy.

No memory-only provider invocation, background review, embedding call, or
post-Send model call is permitted in v1.

## Frozen live benchmark

The harness is `.local/bench/turn-latency.ts`. It drives the production path
`ConnectorWorker -> ProviderSessionManager -> provider runner` against this
repository. Cloud transport is replaced by an in-process timestamping stub.
Every measured turn uses `sessionMode=fresh`, read-only repository access, no
runtime network tools, and the production two-pass schemas and limits.

Question, unchanged between comparisons:

> How does the connector decide a pairing code has expired, and is the five
> minute TTL configurable? I need to know what the browser should show once the
> code is consumed but the credential is not visible yet.

Pinned providers:

- Claude CLI 2.1.263, model `sonnet`;
- Codex CLI 0.153.4, model `gpt-5.6-sol`.

### Pre-change baseline

Three trials per provider were captured before production memory changed.

| Provider | Trial totals | Median total | Median investigation | Median drafting | Usable answers |
| --- | --- | ---: | ---: | ---: | ---: |
| Claude Sonnet | 49.88s, 40.13s, 41.44s | 41.44s | 21.59s | 19.84s | 3/3 |
| Codex GPT-5.6 Sol | 58.36s, 119.25s, 67.67s | 67.67s | 56.06s | 16.05s | 3/3 |

Codex trial 2 hit the existing 60-second investigation deadline and recovered
by investigating during drafting, producing the 119.25-second tail. It remains
in the sample because tail failures are user experience, not outliers to hide.

### Final comparison protocol

The harness accepts `baseline` or `dialogue-v1` as an explicit profile so both
arms run from the same checkout and provider versions. For each provider:

1. Run one unrecorded warmup per profile.
2. Run ten recorded turns in alternating ABBA order.
3. Keep failures, deadline fallbacks, blocked results, and provider errors.
4. Record total, investigation, drafting, prompt characters, result state, and
   whether the answer is usable.
5. Compare medians and p90, not means alone.

Non-regression gate:

- usable-answer rate must not decrease;
- median total latency regression must be no more than 5%;
- p90 total latency regression must be no more than 10%;
- provider invocation count must remain two;
- prompt characters must be equal or lower;
- the long-dialogue quality case must recover both the intended UX decision
  (`Finishing connection...`, no countdown, then `Command expired`) and what
  the repository currently implements.

A three-trial pre/post sample is a smoke signal only. It cannot establish p90 or
separate a small regression from provider variance. The ten-trial alternating
comparison is the release gate.

### Post-change smoke result

The corrected implementation was measured with the same short-conversation
prompt. All six valid trials produced a prompt of exactly 11,353 characters and
a 164-character persisted summary, byte-identical to baseline on this path.

| Provider | Trial totals | Median total | Median investigation | Median drafting | Usable answers |
| --- | --- | ---: | ---: | ---: | ---: |
| Claude Sonnet | 58.23s, 56.73s failed, 42.98s | 56.73s | 25.97s | 20.38s | 2/3 |
| Codex GPT-5.6 Sol | 69.25s, 179.12s, 67.63s | 69.25s | 52.88s | 16.99s | 3/3 |

Against the three-trial pre-change medians, Claude total latency increased
36.9% and its usable-answer rate fell from 3/3 to 2/3. Codex median total
latency increased 2.3%, but one investigation deadline forced drafting to
re-investigate and produced a 179.12-second tail. Connector overhead across the
valid post-change trials was 0.01-0.23 seconds.

This smoke result fails the release gate. It does not identify dialogue memory
as the cause: short-conversation prompts are byte-identical, memory selection
is local and sub-millisecond, and the observed time is inside provider passes.
It does show that the existing two-pass runtime is too variable to claim an
unchanged user experience from this small sequential sample. No release claim
or PR should rely on this result as a pass.

The Claude failure in this sample was subsequently diagnosed and fixed; see
`Post-hardening Claude re-measurement` below for the superseding Claude
numbers. The Codex tail recorded here still stands.

An earlier Codex attempt was stopped after the elevated process could not see
the authenticated local Codex profile. It made no usable provider turn and is
excluded as benchmark setup error; the three authenticated trials above are
the recorded Codex sample.

### Claude schema-retry hardening

The failed Claude drafting turn was recovered from its local session record.
It made three `StructuredOutput` calls:

1. `privateSummary` was 2,242 characters against a 2,000-character limit and
   `sendCandidate` was absent;
2. the corrected object omitted `riskFlags`;
3. the final object omitted `state`, `riskFlags`, and `sourcePaths`.

Claude's validation feedback caused each retry to replace the object rather
than resend every already-valid property. The third rejection consumed the
configured turn limit, and the CLI exited without a final structured object.

The runner now retains bounded structured-output attempts in memory. Only when
Claude terminates with `error_max_turns`, it reconstructs an object by applying
attempts chronologically: a newer supplied property wins, while an omitted
property retains the most recent earlier value. The reconstructed object is
accepted only if Ajv validates it against the unchanged provider schema. It is
then parsed again by Telaegent's strict Zod protocol schema and passes through
the existing invariant, path, secret, redaction, authorization, and human-Send
guards. No value is invented, defaulted, truncated, or accepted after an
unrelated provider error.

The no-tools drafting pass now uses Claude's `dontAsk` permission mode instead
of `plan`. Its tool surface remains empty, repeated in the deny list, restricted
to the workspace, and without network tools. This removes an irrelevant
planning reminder without granting any additional capability.

Successful-path provider calls and prompt bytes are unchanged. Capturing an
attempt is an in-process shallow copy; schema compilation and reconstruction
occur only after the otherwise-terminal max-turn failure. The exact observed
three-attempt sequence is a regression fixture against the committed recipient
production schema.

### Post-hardening Claude re-measurement

The hardened build was re-measured with the identical `recipient` scenario,
`dialogue-v1` profile, and short-conversation prompt used above.

| Sample | Trial totals | Median total | Usable answers |
| --- | --- | ---: | ---: |
| Claude, pre-hardening | 58.23s, 56.73s failed, 42.98s | 56.73s | 2/3 |
| Claude, post-hardening | 44.07s, 56.68s, 50.06s | 50.06s | 3/3 |

Usable-answer rate returned to 3/3 and median total latency fell 11.8% against
the failing sample. Every trial returned `state: "ready"` with a grounded answer
citing `apps/server/src/connectors/connector-pairing.ts`.

No trial terminated with `error_max_turns`, so the reconstruction path was not
exercised live and remains covered only by the offline regression fixture. The
live improvement is attributable to the drafting pass no longer running in
`plan` mode: prevention, not recovery, carried this sample.

This clears the Claude half of the smoke gate. The Codex 179.12-second tail is
unchanged by this work and remains an open runtime-variance question rather than
a memory question. The ten-trial alternating comparison is still the release
gate; three trials remain a smoke signal.

## Intermediate live sample, invalidated

An initial post-change Claude sample measured 53.02s, 39.79s, and 50.83s, but it
is not the final comparison: the early implementation removed a duplicated
164-character metadata summary on short conversations. One turn hit the known
three-turn drafting cliff, one incorrectly blocked on provider-injected text,
and one returned a grounded answer. The implementation was corrected so short
conversations are byte-identical to baseline before any final A/B is accepted.

Keeping this failed sample in the record is intentional. Speed includes usable
completion rate, and a favorable median cannot excuse a missing answer.
