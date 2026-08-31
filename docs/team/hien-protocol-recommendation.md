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

Do **not** claim that P5 is the best-performing format for Codex. With equivalent
native schema enforcement, P3 scored 0.956 and P5 scored 0.954 on the same
balanced ten-case sample. That is a tie, not a provider-specific reason to
switch formats. P5 remains the product choice because it is reconstructable.

## Evidence by provider

| Provider/run | Relevant result | Interpretation |
| --- | --- | --- |
| Claude Code | P5 0.982 vs P3 0.971 on 25 non-safety cases; equal safety on the 35-case adversarial run | Supports P5 for Claude, with a small quality advantage |
| Codex | Native schema: P3 0.956 vs P5 0.954 on 10 cases each; zero leaks and parse failures | Equivalent production constraint removes the old P5 gap; formats tie on this sample |
| DeepSeek V4 Flash | M4 1.000 vs M5 0.994 on memory; P4 targeted safety 100% but seven over-blocked cases | Supports M4 and rejects raw transcript replay as the default |

## P0 contract

1. Telaegent owns durable approved shared memory; provider sessions remain
   disposable private caches.
2. Default to P5/M4 for reconstructable context and explicit instructions.
3. Enforce secrets, repository boundaries, capabilities, and send approval in
   deterministic backend/connector policy, never in the prompt alone.
4. Keep format selection behind the runtime adapter so later provider evidence
   can change the local rendering without changing the cloud contract.
5. Treat provider rankings as provider-specific and record the runner/schema
   configuration with every claim.

## Remaining validation

The native-schema comparison is complete. A full 75-case rerun would narrow the
confidence interval but is not justified for P0 after a measured 0.002 tie and
zero schema failures. Run it only when changing the Codex prompt or model.
