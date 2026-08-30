# Telaegent Architecture

## Status

This document describes the target architecture from the [canonical product plan](../product/high-level-plan.md). It is not a claim that the local connector and cloud relay have already been fully implemented. The inherited Starter Kit and earlier prototypes remain in the tree as legacy scaffold.

## Product topology

```mermaid
flowchart TB
    Browser["React/Vite browser product"] --> API["Caddy + Fastify control plane"]
    API --> DB["Supabase Auth / Postgres / Realtime"]
    API --> Relay["Connector presence and job relay"]
    Relay <--> A["User A local connector"]
    Relay <--> B["User B local connector"]
    A --> AGH["Local GitHub CLI as User A"]
    A --> AREPO["User A local repository"]
    A --> AP["Local Claude Code and/or Codex CLI"]
    B --> BGH["Local GitHub CLI as User B"]
    B --> BREPO["User B local repository"]
    B --> BP["Local Claude Code and/or Codex CLI"]
```

Frontend hosting is provisionally Vercel. The control plane is provisionally Azure behind Caddy/HTTPS. Supabase is provisionally in Southeast Asia/Singapore. Azure is not an agent execution platform; it hosts coordination and relay services only.

## Isolation boundary

The minimum trust unit is user x repository.

Each local connector binding requires:

- one connector binding owned by one user and stable repository ID
- a connector-selected registered local workspace, never a cloud- or collaborator-provided path
- no cross-project path resolution
- the owning developer's local GitHub/provider credentials only
- bounded CPU, memory, time, output, and cancellation
- log redaction and safe cleanup/revocation

A new process is not automatically a new identity. The local connector must bind GitHub, Claude, and Codex home/config/session state to the owning developer and project without uploading that state.

The concrete infrastructure handoff and acceptance checks are defined in
[Local connector execution requirements](./runtime-isolation-requirements.md).
Normalized provider states and recovery behavior are defined in
[Provider failure and reconnect behavior](./provider-failure-reconnect.md).

## Control-plane responsibilities

- Telaegent identity and sessions
- stable GitHub repository identity and proven access
- project memberships and collaborator connection state
- shared conversations and approved messages
- private-draft metadata/status without cross-user visibility
- exact outbound approval and idempotent send
- connector/provider status and opaque connector binding IDs
- safe audit and correlation IDs
- compact conversation memory for provider rehydration

## Local connector responsibilities

- local GitHub CLI access verification and safe repository metadata registration
- Claude Code/Codex installation and provider connection probe
- fresh or resumed local Telaegent-created provider sessions
- sender draft and recipient answer turns
- bounded repository inspection
- structured candidate output
- timeout, cancel, reconnect, and session-loss behavior

## Conversation state

```text
private draft: created -> agent working -> clarification/ready/blocked
ready -> human edit/send/cancel
send -> atomic approved shared message
incoming shared message -> recipient private agent -> recipient approval -> shared response
```

Only approved content belongs to the shared conversation. Provider sessions are caches; Supabase-backed Telaegent conversation state is durable memory.

## GitHub access

P0 does not require a GitHub App. The connector uses the developer's existing local GitHub CLI authentication, local remote, branch, and commit. If authentication is missing, the user runs `gh auth login` locally; the cloud neither initiates nor stores that login.

Collaborator discovery uses mutual proof: both Telaegent users independently connected the same stable GitHub repository ID. It does not depend on one user having permission to enumerate every repository collaborator.

## Unresolved gates

- connector packaging, authentication, update, and revocation
- local Claude Code/Codex probing and supported non-interactive invocation
- WebSocket versus long-poll job delivery and reconnect semantics
- local user x repository workspace/provider-session isolation
- private-draft retention
- safe repository metadata refresh/branch policy
- polling versus SSE versus Supabase Realtime
- measured latency and cost

Do not freeze these through code before the owner briefs' experiments are complete.
