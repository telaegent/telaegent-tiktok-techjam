# Provider-aware protocol recommendation

**Decision date:** 2026-08-31  
**Task:** 5 — confirm whether P5 remains the Codex/default recommendation

## Decision

Use **P5 with M4 memory as Telaegent's P0 default context contract**, while
keeping the provider adapter capable of selecting a validated provider-specific
format.

P5 remains the product default because Telaegent can reconstruct it from its
durable approved conversation after a provider session is lost. M4 is the
measured memory choice: deterministic compact summary plus the last eight
approved turns.

Do **not** claim that P5 is the best-performing format for Codex. The completed
Codex run ranked P3 above P5, but native output-schema enforcement was absent,
so the large difference mainly establishes that P5 was less reliable at
eliciting unassisted JSON in that runner. It does not justify switching the
whole product to P3, and it does invalidate any universal "P5 wins every
provider" claim.

## Evidence by provider

| Provider/run | Relevant result | Interpretation |
| --- | --- | --- |
| Claude Code | P5 0.982 vs P3 0.971 on 25 non-safety cases; equal safety on the 35-case adversarial run | Supports P5 for Claude, with a small quality advantage |
| Codex | P3 0.970 vs P5 0.796 on 75 cases each; zero leaks for both | P3 was more robust without native schema enforcement; result has a known runner limitation |
| DeepSeek V4 Flash | M4 1.000 vs M5 0.994 on memory; P4 targeted safety 100% but seven over-blocked cases | Supports M4 and rejects raw transcript replay as the default |

## P0 contract

1. Telaegent owns durable approved shared memory; provider sessions remain
   disposable private caches.
2. Default to P5/M4 for reconstructable context and explicit instructions.
3. Enforce secrets, repository boundaries, capabilities, and send approval in
   deterministic backend/connector policy, never in the prompt alone.
4. Keep format selection behind the runtime adapter so a schema-constrained
   Codex rerun can justify P3 for Codex without changing the cloud contract.
5. Treat provider rankings as provider-specific and record the runner/schema
   configuration with every claim.

## Deferred validation

A future Codex P3/P5 comparison should pass the identical native output schema
to both formats. That rerun is worthwhile before optimizing Codex-specific
quality, but it does not block P0 because the backend safety boundary and the
reconstructable P5/M4 contract are already decided.
