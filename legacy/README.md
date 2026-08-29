# legacy/

Code from the **v1 product direction**, superseded by
[`docs/plan/TELAEGENT_HIGH_LEVEL_PRODUCT_PLAN.md`](../docs/plan/TELAEGENT_HIGH_LEVEL_PRODUCT_PLAN.md).

**Nothing here was deleted.** It is archived rather than removed because parts
of it are directly reusable and because the security work in particular
represents real effort that the new plan still needs.

It is unwired from the running server, excluded from typecheck and the test
suite, and will not build. Treat it as a reference to harvest from, not as
code to run.

## Why it was superseded

v1 encoded one fixed workflow as the entire product:

```text
publish intent → detect conflict → exchange status → propose resolution
→ dual approval → ContextPack → dependency change → replan → audit
```

The new plan replaces that with a smaller primitive — project-scoped,
human-gated messaging between separately owned coding agents — and states
plainly that *"the central product primitive is no longer a fixed
conflict-detection workflow."* v1 also assumed a local Fastify server and
local containers, which the cloud-first architecture explicitly removes.

## What is in here

### `telaegent-v1/` — the coordination workflow (47 files, ~13.5k lines)

**Worth harvesting.** These solve problems the new product still has:

| File | Why it still matters |
| --- | --- |
| `context-policy.ts` | Path authorization: `.env`, traversal, absolute paths, symlink escape, workspace containment. This is close to the deterministic secret guard the new plan requires in §12, and to the guards `docs/hien.md` asks for. |
| `redaction.ts` | Scrubs audit events before persistence — still needed under the new audit model. |
| `request-rules.ts` | Deterministic request classification. |
| `git-helper.ts` | Branch/commit/status helpers; the new plan needs repo revision context (§16). |
| `ports.ts` / `ports.node.ts` | The filesystem/git/runner seam that makes the policy code testable without a live provider. |
| `testing/` | In-memory filesystem and fake runners — directly reusable for Hien's protocol harness. |
| `schemas.ts` | Zod validation patterns, if not the specific schemas. |

**Superseded by the new direction:**

`conflict-engine.ts`, `agreement-engine.ts`, `context-pack-validator.ts`,
`dependency-impact.ts`, `state-machine.ts`, `permission-engine.ts`,
`service.ts`, `routes.ts`, `tool-dispatcher.ts`, `phoenix-fixture.ts`,
`demo-evidence.ts`, `contract-fixtures.ts`.

### `local-container-runtime/` — local/ECS deployment

The v1 architecture ran agents in local Docker containers and deployed to
Volcengine ECS. The new plan is cloud-hosted with per-user×repo isolation, so
the Terraform and the local POC launcher no longer describe the target. Kept
because Thai's brief still needs container mechanics as input.

## Known bugs in the archived code

Recorded so the knowledge is not lost with the code. These were live at the
time of archiving and are **not** fixed:

1. **Flaky fixture commit SHAs.** `git-helper.ts` `initRepository` pins
   `user.name` and `user.email` but not `GIT_AUTHOR_DATE` /
   `GIT_COMMITTER_DATE`. Two independent `git init` + commit sequences produce
   different SHAs whenever setup straddles a one-second boundary, which adds a
   spurious `base_commit` conflict signal and makes
   `integration.test.ts` assert 6 where it expects 5. Reproduces on any
   platform; observed failing 2 runs in 3 on Windows. **If the git helpers are
   harvested, pin both date env vars.**

2. **8.3 short-path containment failure (Windows).** `resolveInsideWorkspace`
   compares a canonical root against `fs.realpath` output. On Windows,
   `os.tmpdir()` returns the short form (`C:\Users\VICTOR~1\...`) while
   `realpath` expands nested paths to the long form
   (`C:\Users\Victoria Pham\...`), so `isInside` rejects legitimate paths and
   every approved file is denied. The check is behaving correctly; the root it
   is given is not canonicalized. **Canonicalize the root before comparing.**

3. **POSIX assumptions in the test harness.** `testing/fake-ports.ts`
   hardcodes `/tmp/telaegent-test` and several assertions expect
   forward-slash relative paths, so five `context-workspace.test.ts` cases fail
   on Windows. Harness portability, not product logic.

## Test coverage that left CI with this move

Archiving removed 270 tests from the suite: the repository went from
**29 files / 301 tests (7 failing)** to **9 files / 31 tests (0 failing)**.

The green suite is therefore *not* evidence that the failures were fixed —
they are the three bugs listed above, still present, now unexecuted. Any code
harvested from here needs its tests brought across and made to pass.
