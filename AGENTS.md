# Telaegent Repository Instructions

## Canonical product direction

The product is **Telaegent**, a cloud-first, project-scoped messaging and trust
layer between independently owned coding agents. Cloud-first describes the
product and coordination plane, not provider execution: GitHub CLI, Claude
Code, Codex, repositories, credentials, and provider sessions stay local on
each developer's machine and are reached through an outbound connector.

Before changing product behavior, architecture, API contracts, runtime
integration, security policy, UX, demo flow, or implementation plans, read:

1. `docs/product/canonical-build-plan.md`
2. `docs/product/high-level-plan.md`
3. `docs/product/product-flow.md`
4. `docs/architecture/overview.md`
5. `SECURITY.md`
6. the relevant owner brief under `docs/team/`

For GitHub authentication, repository access, collaborator trust, or backend
authorization work, also read `docs/team/khoa.md` and
`GITHUB_CONNECTION_DESIGN.md` when that design file is present.

## Source-of-truth precedence

Use this order when project material conflicts:

1. the user's latest explicit direction;
2. the canonical product and architecture documents listed above;
3. current owner research and validated experiment results;
4. the active implementation;
5. preserved legacy material.

`docs/product/canonical-build-plan.md` is prescriptive and wins on
architecture: what runs where, what to build, what to prove, and who owns it.
`docs/product/high-level-plan.md` is descriptive and wins on product behaviour.
Both freeze direction rather than schedule work, and the research gates they
name are still open. Do not turn an unvalidated hypothesis into a production
claim.

## Non-negotiable product principles

- The judged product is browser-first and cloud-hosted, with a required local
  connector for repository and provider execution.
- A stable GitHub repository ID is the project boundary.
- Collaborator connections are project-scoped, accepted once, revocable, and
  do not grant direct repository or runtime access.
- Every cross-user message is prepared privately and crosses only after the
  owning human chooses `Send`; editing or rejecting must remain possible.
- GitHub CLI, Claude Code, Codex, repositories, credentials, tools, and
  provider sessions run locally on each developer's machine. Telaegent cloud
  must never launch them or store their credentials.
- Telaegent's approved shared project conversation is durable memory; provider
  sessions are private working caches.
- The minimum local execution isolation unit is user x repository. The cloud
  stores only an opaque connector binding and safe repository/runtime status;
  local paths are resolved and enforced by the connector.
- Obvious secrets, credentials, cross-project paths, and another user's private
  state remain backend-enforced denials even if an agent or human requests them.

## Superseded material

The fixed Phoenix conflict workflow, ContextPack exchange, dependency-replan
state machine, ModelArk/Volcengine deployment, and LAN-worker plans are not the
canonical product architecture. They remain in the current scaffold and under
`unused-code/` only for history, reusable implementation patterns, and build
continuity.

Do not extend those legacy workflows as though they define the new product.
Migrate reusable pieces incrementally and keep existing tests passing while the
new project messaging model is implemented.

## Current research ownership

Khoa and Phuong co-own the backend. Khoa owns local GitHub authentication,
repository discovery and proof of access, project-scoped collaborator trust,
authorization, and revocation. Phuong owns provider runtimes, sessions,
the local connector, conversation orchestration, and durable Telaegent memory.
Their shared connector/cloud data and API contracts must be agreed before broad
implementation.
