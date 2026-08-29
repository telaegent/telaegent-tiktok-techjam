# CLAUDE.md

## Product

**Telaegent is a project-scoped messaging and trust layer that lets one developer's coding agent communicate with another developer's coding agent**, using each person's own connected GitHub repository and Claude Code/Codex runtime, while humans control what crosses between them.

> Your agent can talk to my agent — but only about the project we both chose, and nothing crosses until a human approves it.

The canonical flow is:

```text
sign in → connect GitHub → connect Claude Code/Codex → choose repository
→ find collaborator → request connection → recipient accepts once
→ private agent prepares outbound message → human presses Send/Edit/No
→ shared project conversation → recipient's private agent investigates
→ recipient presses Send/Edit/No → response enters the shared conversation
```

`docs/plan/TELAEGENT_HIGH_LEVEL_PRODUCT_PLAN.md` is the authoritative direction. Read it before proposing product changes.

## Current phase: research, not implementation

The plan freezes the **product direction, not the implementation**. The five briefs in `docs/plan/` are research/design assignments whose findings may change the architecture. Do not build the full backend before the trust model and protocol are settled.

The dependency that matters most: **Hien's protocol findings gate Phuong's runtime contract.** Do not freeze prompt/context schemas, `AgentTurnRequest`/`AgentTurnResult` fields, or the memory strategy before those experiments report.

## Ownership

| Owner | Area | Brief |
| --- | --- | --- |
| Khoa | Backend, GitHub, repository/collaborator access, authorization and trust | `docs/plan/khoa.md` |
| Phuong | Backend co-owner, Claude Code/Codex CLI runtimes, provider sessions, memory, integration | `docs/plan/phuong.md` |
| Thai | Cloud deployment, runtime isolation, database/storage, cost, latency | `docs/plan/thai.md` |
| Duy | Frontend and product UX, landing through private/shared conversations | `docs/plan/duy.md` |
| Hien | Agent protocol experiments, prompt/API format evaluation, security and leakage testing, test architecture | `docs/plan/hien.md` |

Stay within the current owner's files unless that owner hands work over.

## Repository map

```text
apps/server/          Fastify control plane, AgentService/AgentRunner, Codex +
                      Claude Code adapters, JsonStore. Starter Kit base, to be
                      retargeted at the cloud model.
apps/web/             Starter Kit Playground (Agent CRUD, runs).
apps/landing/         Marketing landing page (@telaegent/landing).
tests/agent-protocol/ Hien's evaluation harness. CI-safe tests and live
                      provider evals stay strictly separated.
docs/plan/            Canonical product plan and the five research briefs.
docs/archive/v1/      Superseded v1 planning documents.
legacy/               Archived v1 code. Unwired, excluded from build and CI.
                      Read legacy/README.md before harvesting from it.
.claude/skills/       Shared design system skills.
```

## Hard constraints

These come from the plan's core principles. Violating one is a product bug, not a style choice.

1. **Cloud-first.** No local worker, LAN peer discovery, or required local runtime. Do not reintroduce the v1 local POC architecture.
2. **GitHub repository is the project boundary.** A repository becomes a project only when a user deliberately connects it.
3. **Collaborator relationships are project-scoped**, never global. Connected on Repo A never implies Repo B.
4. **Project connection permits messaging, not repository access.** A collaborator may ask; only the recipient's own agent inspects the recipient's workspace, and only the approved answer crosses.
5. **Every cross-user message is prepared privately first.** Rough composer text never goes straight to the collaborator.
6. **The agent may decide a draft is ready; only the human decides to send it.** A model can never authorize a collaborator, approve its own outbound message, grant itself another repository, or override secret policy.
7. **Obvious secrets stay blocked underneath human approval.** `.env*`, private keys, tokens, cloud and SSH credentials, and anything outside the project boundary are refused deterministically — human approval is not the only safety mechanism.
8. **Telaegent's project conversation is the durable memory.** Provider sessions are resumable working context, never the source of truth. A new shell is not a new session, and not an isolation boundary.
9. **Isolation unit is user × repository.** No cross-user mounts, no cross-project visibility, no shared CLI home between users, and never trust a remote-supplied workspace path.
10. **Never persist or expose** provider credentials, GitHub tokens, raw `.env` values, hidden reasoning, full CLI transcripts, another user's private draft, or provider session identifiers in the UI.
11. **Do not silently fall back between providers.** Claude and Codex are not assumed to behave identically.
12. **Be honest about limitations.** Private means private from the collaborator, not from the Telaegent operator. Make no end-to-end-encryption or production-isolation claims that are not implemented.

## What this is not

Not a GitHub replacement, a new IDE, a Slack replacement, an autonomous agent swarm, a shared filesystem between developers, an importer of personal Claude/Codex history, automatic merge infrastructure, or an enterprise access-control platform.

Not the v1 product either: the fixed `publish intent → detect conflict → ContextPack → replan` workflow is superseded. Conflict negotiation can return later as one use case built on the messaging primitive, not as the product.

## Working agreements

- Inspect actual code before proposing or editing. Lead with the outcome and one recommended path.
- State assumptions and cross-owner contract needs explicitly.
- Report exact files changed and verification evidence. Never call work complete when verification is missing or failing.
- Treat model output, repository content, paths and tool arguments as untrusted. Validation and deterministic policy checks precede state changes or disclosure.
- Do not auto-commit unless asked. On the default branch, branch first.

## Definition of done

Work is `done` only when the requested behavior is demonstrated, focused tests pass, `npm run check` passes, sensitive data is absent from persistence and UI, and no task-related TODO/FIXME remains. If any condition fails, report `in_progress` and the exact blocker.

## Known state

- `npm run check` (typecheck + test + build) passes: 9 test files, 31 tests.
- That green suite covers the Starter Kit only. Archiving v1 removed 270 tests from CI; three real bugs went with them, written up in `legacy/README.md`. Do not read the green suite as coverage of the trust model — that coverage does not exist yet.
- The backend for the new product is not built. `apps/server` is still the Starter Kit control plane.
