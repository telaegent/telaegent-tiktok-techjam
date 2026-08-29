# Preserved Superseded Material

Nothing in this directory is part of the canonical Telaegent product direction dated 2026-08-29. It is retained so earlier team work remains recoverable and reviewable.

## Contents

### `legacy-plans/`

Superseded fixed-workflow and LAN-worker plans, including the former Phoenix conflict, dual approval, ContextPack, dependency-change, and replanning design.

The conflict workflow may later return as an application built on top of project-scoped messaging. The LAN worker remains a documented fallback if cloud CLI authentication/isolation proves infeasible.

### `legacy-docs/`

Earlier A2A request contracts, backend contracts, protocol/security designs, Phoenix snapshots, Starter Kit screenshots, and source hackathon guide/XML material tied to the superseded fixed workflow or inherited baseline.

### `modelark-volcengine/`

Standalone deployment documentation, Terraform, and shell scripts for the inherited ModelArk/Volcengine architecture.

## Legacy source still outside this directory

Some inherited code is still imported by the current scaffold and therefore remains in its original location:

- ModelArk configuration and Codex transport in `apps/server/src/config.ts` and the Codex runners
- fixed Phoenix/Telagent workflow modules in `apps/server/src/telagent/`
- inherited Starter Kit UI and local POC scripts

Those files are not canonical architecture. They were deliberately not moved because the user prohibited new implementation code, and moving active imports without replacements would knowingly break the build.

When implementation is authorized, migrate incrementally with tests. Do not delete these artifacts until the team explicitly decides their retention policy.
