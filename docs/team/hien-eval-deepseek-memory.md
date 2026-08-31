# DeepSeek V4 Flash memory evaluation

**Date:** 2026-08-31  
**Runner:** Codex CLI repository/tool shell backed by `deepseek-v4-flash`  
**Sandbox:** read-only  
**Raw output:** OS temporary directory only; never committed

## Task 2 — M5 rerun

The executable corpus currently contains nine `mem.*` cases. The older
findings memo says eleven; the command below is the source of truth for this
run and selected all nine cases that exist in `ALL_CASES`.

```powershell
$env:TELAEGENT_LIVE_EVAL='1'
npm run eval:deepseek -- --formats P5 --memory M5 --cases mem. `
  --max-turns 9 --timeout 180000 --out <temporary-directory>
```

| Memory | Cases | Safety | Score | Leaks | Parse failures | Mean prompt tokens | Mean duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| M5 | 9 | 100% | 0.994 | 0 | 0 | 1,644 | 36.5 s |

The earlier M5 result is superseded. That run was invalidated by a provider
quota response; this rerun completed with no provider refusal and no parse
failure. One case, `mem.contradicts_repository`, asked an unnecessary
clarifying question even though the request was answerable.

The API key was supplied only through the process environment. It is absent
from prompts, commands recorded in this report, raw result summaries, and Git.

## Task 3 — M4 versus M5 decision

M4 was rerun against the same nine cases, model, schema, sandbox, and timeout.

| Memory | Cases | Safety | Score | Leaks | Parse failures | Mean prompt tokens | Mean duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| M4 | 9 | 100% | 1.000 | 0 | 0 | 1,675 | 35.6 s |
| M5 | 9 | 100% | 0.994 | 0 | 0 | 1,644 | 36.5 s |

### Decision

Use **M4: deterministic compact summary plus the last eight approved turns**
for P0 rehydration.

The aggregate difference is small, but it is concentrated in the exact failure
the summary is meant to prevent: M5 unnecessarily asked for clarification in
`mem.contradicts_repository`, while M4 answered it. M4 costs only 31 additional
prompt tokens on this corpus and was slightly faster in this run. The current
`compactSummary` implementation is deterministic and extractive, so choosing
M4 does not add a second provider call or another model failure path.

Keep M5 as a fallback if no durable summary can be produced, but do not make it
the canonical rehydration context while this measured continuity loss remains.
