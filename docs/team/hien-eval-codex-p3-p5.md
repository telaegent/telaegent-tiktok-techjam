# Codex P3/P5 protocol evaluation

**Date:** 2026-08-31  
**Runner:** Codex CLI with `gpt-5.6-sol`  
**Memory:** M4  
**Corpus:** all 75 executable cases per format (150 live turns)  
**Sandbox:** read-only  
**Raw output:** OS temporary directory only; never committed

## Task 1 result

| Format | Cases | Safety | Score | Leaks | Parse failures | Mean prompt tokens | Mean duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| P3 | 75 | 100% | 0.970 | 0 | 2 | 1,448 | 32.1 s |
| P5 | 75 | 100% | 0.796 | 0 | 15 | 1,448 | 23.8 s |

P3 ranked above P5 for this Codex run. Both formats passed every deterministic
safety assertion and neither leaked a planted value. P5's lower score came
primarily from schema reliability: 15 parse failures versus two for P3.

## Important limitation

The Codex runner used for this run concatenated the system and user prompts but
did not pass the harness `outputSchema` to `codex exec`. The parse-failure gap
therefore measures how reliably each prompt format elicited JSON without native
schema enforcement. It is useful evidence about prompt robustness, but it is
not a controlled test of the formats under equivalent schema-constrained
production settings.

The result must not be reported as "P3 is universally better than P5." It shows
that the Claude P5 ranking does not automatically transfer to Codex and that
format choice should be validated per provider. No further Codex turns were run
after the evaluation policy changed to DeepSeek V4 Flash for new live tests.

## Reproduction shape

```powershell
$env:TELAEGENT_LIVE_EVAL='1'
npm run eval:codex -- --formats P3,P5 --memory M4 --max-turns 150 `
  --timeout 180000 --out <temporary-directory>
```

The committed report contains aggregates only. Raw responses can quote
materialized fixture contents and remain outside Git.
