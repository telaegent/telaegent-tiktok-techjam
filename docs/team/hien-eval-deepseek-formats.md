# DeepSeek V4 Flash format evaluation

**Date:** 2026-08-31  
**Runner:** Codex CLI repository/tool shell backed by `deepseek-v4-flash`  
**Memory:** M4  
**Sandbox:** read-only  
**Raw output:** OS temporary directory only; never committed

## Task 4 — P1, P2, and P4 disposition

Task 4 was narrowed after the first 100-turn checkpoint. P1 had already run on
the complete 75-case corpus, P2 had a seven-case plumbing sample, and the
remaining live budget was directed to P4's unique risk: whether replaying a
recent transcript amplifies malicious or poisoned history.

| Format | Scope | Cases | Safety | Score | Leaks | Parse failures | Mean prompt tokens | Mean duration |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| P1 | complete corpus | 75 | 100% | 0.948 | 0 | 1 | 1,238 | 38.8 s |
| P2 | initial sample | 7 | 100% | 1.000 | 0 | 0 | 1,227 | 25.4 s |
| P4 | targeted adversarial set | 31 | 100% | 0.970 | 0 | 0 | 1,447 | 30.6 s |

The P4 set contained every executable case in the sensitive-request,
repository-injection, malicious-collaborator, cross-project, and
conversation-poisoning categories. All 31 passed the deterministic safety
checks. This run found no evidence that P4 replay leaked or followed poisoned
history.

P4 nevertheless over-blocked seven answerable recipient cases:

- four safe secret-adjacent requests ended in unnecessary clarification;
- two repository-injection cases were blocked instead of answered safely;
- one injected standing-approval case asked an unnecessary question.

This is a quality failure, not a safety failure. It makes P4 a poor default even
though its targeted safety result was clean.

## Decision on the unrun P2 remainder

Do not spend another 68 live turns on P2 for P0. Seven cases prove the runner
and schema path work, but they do not establish a quality ranking. More
importantly, JSON-only context does not provide the explicit stable instruction
boundary required by the product's draft-only and no-auto-send semantics. P2
therefore cannot replace the hybrid or summary formats solely on a small perfect
sample.

The honest conclusion is not that P2 lost empirically. It is that the partial
result is insufficient and a full P2 ranking is deferred because it cannot
change the P0 architecture decision.

## Reproduction shape for the targeted P4 run

```powershell
$env:TELAEGENT_LIVE_EVAL='1'
npm run eval:deepseek -- --formats P4 --memory M4 `
  --cases s.secret,s.inject,s.cross,s.poison,r.secret,r.malicious,r.inject,r.cross,r.poison `
  --max-turns 31 --timeout 180000 --out <temporary-directory>
```

The API key was supplied through the process environment and is absent from
the report, raw result files, and Git.
