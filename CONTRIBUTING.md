# Contributing to Telaegent

## Before work

1. Read `docs/product/high-level-plan.md` and `docs/product/product-flow.md` completely.
2. Read the relevant owner brief under `docs/team/`.
3. Inspect the current branch and working tree; preserve teammate changes.
4. State whether the work is research, documentation, legacy maintenance, or authorized implementation.

The current guide freezes product direction but intentionally defers the implementation plan. Do not add speculative cloud execution code: Telaegent cloud coordinates, while the local connector executes GitHub and provider CLI work.

## Current workstreams

- Phuong and Khoa co-own backend architecture.
- Duy owns product/frontend design.
- Hien owns protocol and security evaluation.
- Thai owns cloud infrastructure and connector-to-cloud networking research.

These are research/design responsibilities, not permanent code ownership. Shared contracts should be frozen only after the assigned experiments.

## Product invariants

- cloud-first, browser-first product with a required outbound local connector
- local GitHub CLI, repository, Claude Code/Codex, credentials, tools, and provider sessions
- cloud coordination, routing, approvals, shared memory, presence, and audit only
- GitHub repository as project boundary
- project-scoped collaborator connection
- private sender and recipient agent rooms
- explicit Send/Edit/No before every cross-user agent message
- deterministic secret and project-scope protection
- shared approved conversation as canonical memory
- no direct collaborator filesystem or provider access

## Legacy material

Do not delete earlier implementation. Preserve standalone retired plans, research, and deployment assets under `unused-code/`. Imported legacy source may remain in place until an authorized replacement exists and tests prove it can move safely.

## Verification

For current scaffold maintenance:

```bash
npm run check
```

Live Claude/Codex protocol evaluations must be optional commands, not required normal CI. Use fake secrets and controlled repositories only.

Every handoff should state:

- files changed
- evidence gathered
- target architecture versus legacy behavior
- unresolved decisions and owner
- tests/checks run
