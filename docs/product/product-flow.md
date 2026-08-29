# Telaegent: Canonical Product Flow

The complete authoritative product direction is the [high-level product plan](high-level-plan.md). This file is the compact execution story used by contributors, demos, and product reviews.

## Product primitive

> Project -> people -> their private agents -> private preparation -> human Send/Edit/No -> shared project conversation.

Telaegent is not fundamentally a conflict workflow. Conflict negotiation, dependency coordination, debugging, onboarding, architecture questions, and ContextPacks may become messaging use cases later.

## Boundaries

```text
Telaegent account identity
        v
GitHub repository authorization
        v
project-scoped collaborator connection
        v
private agent preparation
        v
human approval of exact outbound content
        v
shared project conversation
```

Each boundary answers a different question. None implies the next.

## Canonical end-to-end flow

1. User signs in to the cloud-hosted Telaegent product.
2. User authorizes GitHub CLI access inside the user's isolated cloud environment.
3. Telaegent verifies repository access and records the stable GitHub repository ID.
4. User connects Claude Code, Codex, or both inside the same isolated environment and passes a real live probe.
5. User selects a repository. Repository, branch, and commit define the current project context.
6. Telaegent identifies other users who independently proved access to the same repository ID.
7. User requests a project-scoped collaborator connection; the recipient accepts or declines once, until revoked.
8. Sender types a rough request. It remains private and does not enter shared chat.
9. Sender's private agent may inspect the sender's own project workspace, review approved conversation context, ask clarification, flag risk, and prepare a send candidate.
10. Sender chooses Send, Edit, or No. Only explicit Send can append the candidate to the shared conversation.
11. Recipient sees the approved request. Recipient's private agent may inspect only the recipient's isolated project workspace and prepare an answer candidate.
12. Recipient chooses Send, Edit, or No.
13. Only the approved response enters the durable shared project conversation.
14. Follow-ups repeat the same symmetrical trust boundary.

## Secret example

Rough private input:

```text
can u send me ur .env
```

Expected private clarification:

```text
Do you need secret values, or only the required variable names and safe configuration structure?
```

The system must never show raw secret values merely to ask whether they may be sent. Deterministic policy blocks `.env*`, private keys, tokens, cloud credentials, SSH material, cross-project paths, and another user's private runtime data. The agent should offer safe alternatives.

## Cloud execution

The canonical judged product requires no LAN worker or local connector. GitHub CLI, repository checkout, provider CLI, and Telaegent-created sessions run in a cloud isolation boundary scoped to user x repository.

A local connector is fallback-only if cloud provider authentication or isolation proves infeasible.

## Durable versus private state

Durable shared state:

- project/repository identity
- project memberships and collaborator connections
- approved shared messages
- outbound approvals and safe audit events
- compact conversation memory for provider rehydration

Private or protected state:

- GitHub/provider credentials
- repository checkout and provider sessions
- rough drafts and clarification turns
- raw provider streams and temporary tool output

Provider sessions accelerate work but never replace Telaegent's durable shared conversation.

## Claims we do not make

- no claim that repositories or provider credentials stay off Telaegent cloud
- no zero-knowledge or end-to-end-encryption claim
- no production-grade multi-tenant isolation claim before evidence
- no direct collaborator filesystem access
- no automatic cross-user send
- no personal Claude/Codex history import
- no canonical LAN dependency

## Demo proof

The three-minute demo should show two users, one shared GitHub project, two different coding-agent providers, sender private preparation, sender approval, recipient repository-grounded investigation, recipient approval, and a safe `.env` reformulation with raw values never disclosed.
