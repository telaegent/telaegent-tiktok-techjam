# Hien — remaining important tasks completed

**Date:** 2026-08-31  
**Live work this pass:** 31 completed Codex turns, below the 100-turn checkpoint  
**Raw output:** OS temporary directory only; never committed

This closes the overlapping seven/eight-item lists without repeating work that
already landed through the capability-loop merge.

## 1. Codex P3 versus P5 with native schema

Complete. On the same balanced ten-case sample, P3 scored 0.956 and P5 0.954.
Both had 100% safety, zero leaks, and zero parse failures. The old P5 deficit
was caused by running without native schema enforcement. P5/M4 remains the P0
default because it is reconstructable; Codex quality is tied on this sample.

## 2. Fresh, resumed, lost, and switched provider sessions

Already complete in `provider-session-manager.test.ts` and
`protocol/memory.test.ts`. The tested contract is:

- first turn hydrates durable Telaegent context and starts fresh;
- later turns resume only the same user/repository/conversation/provider scope;
- a missing session is retried once as fresh with durable M4 context;
- provider switches start a separate session and retain approved conversation;
- missing or mismatched durable context fails closed.

## 3. Metadata grounding versus exposure

Five coordination cases were run under three P5 profiles:

| Metadata profile | Cases | Safety | Score | Leaks | Parse failures |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full repository + revision + names | 5 | 100% | 0.996 | 0 | 0 |
| No branch/commit revision | 5 | 100% | 0.970 | 0 | 0 |
| Repository identity only | 5 | 100% | 0.996 | 0 | 0 |

One unnecessary clarification produced the no-revision difference. Five cases
are too small to call 0.026 stable; the actionable result is that personal names
showed no benefit, while removing revision context may hurt branch-sensitive
questions. Keep stable repository identity mandatory. Keep branch/commit as
trusted backend provenance and include it for revision-sensitive turns. Do not
put local paths, provider session IDs, or model-claimed commits in the prompt or
shared message.

## 4. Oversharing and draft-only instructions

The final reported Claude runs contain 120 turns and the Codex runs contain 170
turns. The deterministic scanner found zero planted-secret leaks across those
290 turns. This is evidence that the tested prompts did not leak, not proof
that a model cannot leak.

The finalized instruction is the shared `PERMISSION_BLOCK`: prepare a private
draft; never send, deliver, approve, or claim authority; nothing reaches the
other person until the owning human presses Send. Deterministic guards reject
auto-send and permission claims even when the model ignores that instruction.

## 5. Top five failure patterns

1. **Schema/tooling drift masquerades as model quality.** Missing native schema
   enforcement made P5 look much worse; Codex also rejects otherwise-valid
   `oneOf` schemas.
2. **Safe requests get over-blocked near secret boundaries.** P4 blocked or
   clarified seven answerable secret-adjacent/injection cases; M5 unnecessarily
   clarified one memory contradiction.
3. **Secret detection cannot rely on content heuristics.** Bare tokens and
   filled-in setup documentation evade simple key-shape matching; path denial
   before file access remains the primary defence.
4. **Conversation text can counterfeit authority.** Prior approvals, poisoned
   history, and repository instructions are data, never grants. Capabilities
   come only from deterministic human-approved records.
5. **Provider memory is disposable and scope-sensitive.** Lost or cross-scope
   sessions must rehydrate from approved Telaegent memory or fail closed.

## 6. Safe P0 limits

The current implementation now has explicit ceilings at every layer:

| Boundary | P0 ceiling |
| --- | ---: |
| Capability follow-up rounds per task | 5 |
| Provider turns per private invocation | 3 |
| Resource requests per round/task | 16 |
| Bytes per delivered resource | 256 KiB |
| Total resource bytes per task | 1 MiB |
| Outbound draft | 2,000 characters and 4 KiB UTF-8 |

The UTF-8 byte limit is newly enforced by the deterministic guard; character
counts alone undercount non-ASCII transport size. These are hard ceilings, not
targets. Stop earlier on completion, cancellation, no progress, repeated
denial, revocation, or expiry.

## 7. Capability policy and CI

Already complete. Capability decisions, secret-path denial, workspace
containment, grant expiry/operation, once-grant spending, request budgets, byte
budgets, and five-round exhaustion are tested without a model.

Normal CI runs SQL contracts plus `npm run check` (typecheck, offline tests, and
build). Live runners require `TELAEGENT_LIVE_EVAL=1`, and an offline test asserts
that CI cannot construct them. Paid provider sweeps remain manual and their raw
results remain outside Git.
