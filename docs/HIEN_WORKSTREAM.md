# Workstream #6 — tools, context policy, evidence (Hien)

Status: Day 0 through Day 4 done, **and integrated against the team's real
code** — Duy's types/schemas/engines, Khoa's service and routes, Phuong's runtime
contract. **14 test files, 209 tests**, typecheck clean.

The provisional contracts are gone: `contract.ts` is now an adapter that
re-exports Duy's `types.ts`/`constants.ts` and Phuong's `runtime-contract.ts`,
and `tool-schemas.ts` is a thin map from tool name to Duy's schemas. Nothing in
#6 declares a shared type any more.

Integration stages 4 and 7 of `integration.test.ts` are **no longer stubbed** —
they run Duy's `assessConflict` (asserting the canonical score of 5) and his
agreement engine (asserting one approval is not enough and the second activates).

## Setup

```bash
npm install
npm run check
```

Node 22+, npm 10+. No network needed for any test in this workstream.

## Verified on the demo machine

Run on `C:\Telaegent` with the machine's own Node 22.23.2 / npm 10.9.8 / git 2.34.1:

| Check | Result |
| --- | --- |
| `npm install` | clean, workspace links created |
| Server suite | **14 files, 207 tests, all passing** |
| Server typecheck (`tsc --noEmit`) | clean |
| Web typecheck (`tsc -b`) | clean |
| `demo-evidence.ts` | runs end to end, all proofs green |

Two portability bugs were only visible here and are now fixed:

1. **The fixture test summary parsed as "no test summary".** A colour-enabled
   child writes `Tests \x1b[22m \x1b[1m\x1b[32m9 passed`, so the escape codes
   sit between the word and the digits. `summarizeVitest` now strips ANSI and
   the child runs with `NO_COLOR`. This failed on the demo machine while
   passing in a CI-like shell — exactly the class of bug that only shows up on
   the night of.
2. Earlier: npm workspaces hoist the Vitest binary out of `apps/server`, so it
   must be resolved rather than assumed.

**One thing the team must know:** running from a Linux shell against the
Windows-mounted folder, `npm install` cannot create the `node_modules/.bin`
symlinks, so `npm run check` fails with `tsc: not found` even though the code is
clean. Run the demo natively on Windows (npm writes `.cmd` shims there) or in
WSL2 with the repo on the Linux filesystem — which is what `plan.md` §5 already
recommends. Compilers invoked directly through `node node_modules/typescript/bin/tsc`
work on any path.

## Git history — needs a human, one time

The sandbox this was built through cannot delete files, and git needs to remove
its own `.lock` files after every commit, so only the first commit succeeded and
a probe file was left behind. Fix it once from a **Git Bash terminal on Windows**
at `C:\Telaegent`:

```bash
rm -f .git-probe-test
rm -rf .git
git init -b main

# 1. untouched Starter Kit baseline, as plan.md §5 requires
git add -A -- . \
  ':!apps/server/src/telaegent' ':!apps/server/fixtures' \
  ':!apps/server/vitest.config.ts' ':!apps/server/vitest.fixture.config.ts' \
  ':!HIEN_WORKSTREAM.md' ':!docs/TELAEGENT_SECURITY.md' \
  ':!AGENTS.md' ':!plan.md' ':!TELAEGENT_PRODUCT_FLOW.md' \
  ':!duy.md' ':!hien.md' ':!khoa.md' ':!phuong.md' ':!thai.md'
git commit -m "Import Agent Launchpad Starter Kit, untouched baseline"

# 2. the team's plan
git add AGENTS.md plan.md TELAEGENT_PRODUCT_FLOW.md duy.md hien.md khoa.md phuong.md thai.md
git commit -m "Add Telaegent product flow, build plan and personal briefs"

# 3. workstream #6
git add -A
git commit -m "Workstream #6: tool dispatcher, context policy, isolation, evidence"

git log --oneline
```

Then create the branch the plan assigns you: `git checkout -b feat/tools-context-fixture`.

## What is here

| File | Purpose |
| --- | --- |
| `apps/server/src/telaegent/contract.ts` | **Provisional** shared contract — Hien's written request to Duy. Delete its body and re-export `./types.js` when Duy's lands. Everything in #6 imports from here and nowhere else, so the swap is one file. |
| `apps/server/src/telaegent/ports.ts` | The injection boundary. Hien owns the shape, Khoa implements it. |
| `apps/server/src/telaegent/ports.node.ts` | The only file in #6 that imports `node:fs` or `node:child_process`. |
| `apps/server/src/telaegent/tool-schemas.ts` | Provisional Zod argument schemas for all eleven tools. Duy's `schemas.ts` replaces this. |
| `apps/server/src/telaegent/tool-dispatcher.ts` | Executes authorized tool calls. No store writes, no runner calls, no self-approval. |
| `apps/server/src/telaegent/context-policy.ts` | The ten-step path normalization and always-deny list. |
| `apps/server/src/telaegent/context-workspace.ts` | Isolated approved-source workspace + trusted manifest + safe cleanup. |
| `apps/server/src/telaegent/context-pack-validator.ts` | The twelve-step validation sequence. |
| `apps/server/src/telaegent/redaction.ts` | Pure bounded redaction helpers. Khoa calls these on every conversation entry. |
| `apps/server/src/telaegent/git-helper.ts` | Safe Git evidence and ownership validation. |
| `apps/server/src/telaegent/dependency-impact.ts` | Exact-membership impact detection and plan-revision validation. |
| `apps/server/src/telaegent/phoenix-fixture.ts` | Seeds, branches, tests and resets the Phoenix workspaces. |
| `apps/server/src/telaegent/testing/` | Memory filesystem, fake ports, scripted fake runners. **Shared with Khoa** (finding C12). |
| `apps/server/fixtures/phoenix/` | The Phoenix Web App fixture: 18 files, zero dependencies, 9 of its own tests. |
| `apps/server/src/telaegent/demo-evidence.ts` | Runnable proof script — see below. |
| `docs/TELAEGENT_SECURITY.md` | Security section for the submission README: architecture diagram, guarantee-to-test map, honest encryption answer, threat model. |

## Three guarantees, and where they are proven

1. **`.env` is denied before the file is opened.** `context-policy.test.ts` → "the .env proof": the denial happens while the path is still a string, and `ports.fs.calls` is asserted empty. `integration.test.ts` stage 12 repeats it against a `.env` that genuinely exists on disk in Bob's workspace.
2. **No tool can grant, weaken or resolve its own permission.** The dispatcher receives a decision and refuses anything that is not a resolved `allow`. It never reads approval state. `tool-dispatcher.test.ts` → "permission is never resolved inside the dispatcher".
3. **Model-supplied commits and hashes are never trusted.** The validator overwrites all source metadata from the trusted manifest. `context-pack-validator.test.ts` → "trusted metadata wins", and stage 11 of the integration test asserts the string `claimed-by-model` appears nowhere in the delivered pack.

## Showing the security work

```bash
npx tsx apps/server/src/telaegent/demo-evidence.ts
```

Runs the real code against a real Phoenix workspace and prints, in order: the
seeded `.env` that exists on disk but is never committed; the denial of five
spellings of it with a filesystem call count of zero; the isolated workspace
manifest with per-file SHA-256; the model's claimed commit being replaced by the
trusted one; five kinds of invalid pack being rejected with their rule ids; the
same diff accepted for Bob and refused for Alice; impact naming exactly one
owner; and the audit trail with a secret scan over it.

Nothing in that output is a fixture of a result — only the provider is faked, so
the run is deterministic and offline. It is the material for the submission
screenshots.

## Findings resolved against the real Starter Kit

| ID | Resolution |
| --- | --- |
| C1 | **Confirmed real.** With Vitest defaults the server suite collects 9 fixture tests. `apps/server/vitest.config.ts` scopes to `src/**` and excludes `fixtures/**`. Root `workspaces` is `apps/*`, so the fixture's nested `package.json` is not adopted. `tsconfig.json` already scopes to `src`, so no tsconfig change was needed. |
| C2 | Fixture ships `env.template`; `initializePhoenixWorkspace` writes `.env` into each workspace. Tested: it exists, is never committed, is never opened. |
| C3 | `vitest.fixture.config.ts` runs the fixture's tests on the host's Vitest. Fixture has zero dependencies. Its Vite cache is forced to the OS temp dir — the default would have created `node_modules/` **inside the Agent workspace**, which would appear in `git status` and trip the ownership gate. |
| C4 | **Confirmed.** `AGENT_WORKSPACE_ROOT` defaults to `workspaces/`, already in `.gitignore`. No nested repositories. |
| C5 | `PermissionDecision` gains a resolved-allow variant carrying `ResolvedSourceGrant`. **Needs Duy's sign-off.** |
| C6 | Inverted as planned: #6 owns the try/finally in `withApprovedContextWorkspace`, the provider arrives through `ports.runMiddlewareTurn`. Nothing in #6 imports a runner. |
| C7 | All filesystem access is through `ports.fs`. This is what makes guarantee 1 assertable. |
| C8 | One frozen `CONTEXT_LIMITS`. Note: the five-rule cap is a *disclosure* budget — `normalizeRuleList` exists for ownership scopes, which are not capped. |
| C9 | Git is authoritative. The provider's `changedFiles` is a cross-check; a mismatch becomes a `changed_files_mismatch` audit event. Visible in the integration test's audit timeline. |
| C10 | `validateChangedPaths(changed, agreement)`. No owner names in the module. |
| C11 | `normalizeInterfaceName` / `interfaceMatchKeys` are exported here for Duy's conflict engine to import. |
| C12 | `testing/fake-runners.ts` is owned here and keyed by `(purpose, stage)`. |
| C13 | `relay_request_human_decision` is in `NEVER_DISPATCHABLE` with a test proving it is refused even when it arrives authorized. |

## What integration changed

| Was | Now |
| --- | --- |
| `contract.ts` declared the shared types | Re-exports Duy's and Phuong's; adds only `CONTEXT_LIMITS`, `DenialCode`, `ResolvedSourceGrant` and three narrow views |
| `tool-schemas.ts` declared 11 provisional schemas | Maps tool name → Duy's schema |
| `OwnershipRule.paths` | `OwnershipAssignment.files` |
| `DependencyLink` keyed on owner ids | Keyed on `consumerIntentId` / `providerIntentId` |
| `relay_ask_status` named an agent | Names `targetIntentId`; the recipient is resolved from state, never from model input |
| `relay_complete_task` sent `testsPassed` | Sends `tests: TestEvidence[]`; completion requires *every* test passed |
| Dispatcher ran the provider for ContextPack | Duy's schema puts the candidate in the tool call, so the run moved to Khoa's orchestrator; the dispatcher still rebuilds the isolated workspace and validates against its manifest |

**C5 is resolved, differently and better.** Duy takes the approval as
`PermissionEvaluationContext.existingApproval` and returns a plain `allow`. His
decision carries only `{approvalVersion, sourcePaths}`, so Khoa passes the same
`ExistingApprovalScope` through `DispatchContext.sourceGrant`. No contract
change, and the dispatcher still never reads approval state.

## Open asks, by owner

**Duy** — three, none blocking:
1. **`TELAEGENT_LIMITS` has no per-file byte caps.** `plan.md` §12.3 specifies 32 KiB per file and 64 KiB total; without them the isolated workspace is bounded only by file count. Defined in `contract.ts` for now — move them to `constants.ts` and that block becomes a re-export.
2. **`ownershipAssignmentSchema.files` accepts only exact relative paths**, so a split cannot be expressed as `src/routes/**`. The ownership gate already supports prefixes; widening `filesSchema` to `pathRuleSchema` for ownership would let the demo express a scope instead of enumerating seven files.
3. **`ReportDependencyChangeInput` has a single `interface` field**, but `plan.md` §14.2 says to match intents declaring "Session **or** SessionRepository". An optional `relatedInterfaces` array keeps matching exact. The demo still reaches Alice through the approved dependency link, so this is robustness, not a blocker.

**Khoa**
1. Implement `TelaegentPorts` over `AgentService`. `ports.node.ts` gives you the filesystem, git and test-runner implementations already.
2. `executeToolCall` returns data and never writes — apply `result.record` and `result.entry` inside your atomic mutation, alongside the `auditHint` events.
3. **ContextPack generation is now yours to sequence.** Call `createApprovedContextWorkspace()`, run the provider with **`contextPackRunOptions(workspace.root)`** — it pins read-only, network-none, ephemeral session and the isolated path — then dispatch `relay_create_context_pack` with the candidate. The dispatcher rebuilds the manifest and validates. `context-workspace.test.ts` asserts those four options, so weakening them fails a test.
4. Pass `DispatchContext.sourceGrant` (the `ExistingApprovalScope` you already load, plus `contextRequestId`, `sourceCommit`, `taskScope`).
5. Export an app factory taking an injected runner and temp data dir, so `integration.test.ts` becomes `app.inject(...)`.

**Phuong**
1. `changedFiles` must be workspace-relative POSIX with no leading `./`.
2. ContextPack generation is called with `sandboxMode: "read-only"`, `networkMode: "none"`, `sessionMode: "ephemeral"` and the isolated workspace path. The integration test asserts all four reach the runner.
3. A `fresh`/`ephemeral` run must not return a session id to persist — the fake runner already enforces this.

**Thai**
Sample payloads for every card are in `integration.test.ts`; each `result.entry.payload` is exactly what the snapshot will carry.

## Still to do

- The flow runs through the dispatcher rather than through Fastify. Swapping in `app.inject` needs Khoa's app factory; the assertions do not change.
- No live provider run yet — that is Phuong's gate. The fixture is ready for one.

## One thing to watch

The canonical demo scope resolves to **exactly 8 source files**, which is the
hard maximum in `CONTEXT_LIMITS`. Add a file to the fixture's `src/auth/` or
`tests/auth/` and ContextPack generation fails with `LIMIT_TOO_MANY_FILES` —
during the demo. `phoenix-fixture.test.ts` pins this so the failure lands in CI
instead. If the fixture must grow, raise `maxSourceFiles` with Duy at the same
time.
