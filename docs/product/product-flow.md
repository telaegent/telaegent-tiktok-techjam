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

Human approval can be *narrowed and reused* within one task, never widened. See
[Capability-scoped follow-up](#capability-scoped-follow-up).

## Canonical end-to-end flow

1. User signs in to the cloud-hosted Telaegent product.
2. User starts the local Telaegent connector for the selected local repository.
3. The connector uses the user's local GitHub CLI identity to verify repository access and registers only safe metadata, including the stable GitHub repository ID.
4. The connector detects the user's local Claude Code, Codex, or both and passes a real live probe using the user's existing local authentication.
5. User selects a repository. Repository, branch, and commit define the current project context.
6. Telaegent identifies other users who independently proved access to the same repository ID.
7. User requests a project-scoped collaborator connection; the recipient accepts or declines once, until revoked.
8. Sender types a rough request. It remains private and does not enter shared chat.
9. Sender's local private agent may inspect the sender's own local project workspace, review bounded approved conversation context, ask clarification, flag risk, and prepare a send candidate.
10. Sender chooses Send, Edit, or No. Only explicit Send can append the candidate to the shared conversation.
11. Recipient sees the approved request. Recipient's local connector dispatches it only to the recipient's local private agent, which may inspect only the registered local project workspace and prepare an answer candidate.
12. The recipient agent may need files it does not own. It asks the sender's connector for them. The first request for a file the sender has not granted for this task pauses for the sender to choose Deny, Allow once, or Allow for this task. A file already granted for this task, to this peer, read-only, then resolves automatically by opaque resource ID without interrupting the sender again.
13. Recipient chooses Send, Edit, or No.
14. Only the approved response enters the durable shared project conversation.
15. Follow-ups repeat the same symmetrical trust boundary.

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

## Capability-scoped follow-up

Full specification in [canonical build plan section 8](canonical-build-plan.md).
Task/grant contracts, the resource broker and the bounded autonomous loop are
built. The owner still answers a scope request through the API rather than the
approval dialog, which is not built yet.

Agents may collaborate autonomously, but only inside authority a human already
granted:

> An agent may consume or narrow delegated authority. It may never
> autonomously broaden it.

```text
A approves for task X:  LandingPage.tsx READ, LandingPage.css READ

B asks for LandingPage.tsx again   -> auto
B asks for LandingPage.css again   -> auto
B asks for settings.ts             -> A decides
B asks to WRITE LandingPage.tsx    -> denied in P0
B asks for .env                    -> hard denied
```

When B needs something new, A sees what, why, and at what access level, then
chooses **Deny**, **Allow once**, or **Allow for this task**. The third option
adds that one file to this task's read-only scope so later requests resolve
without interrupting A again; it expires with the task or on revocation.

The separation that makes this safe:

```text
using existing authority   -> may be automatic
gaining new authority      -> human approval
final cross-user message   -> human Send
```

## Cloud coordination and local execution

The canonical judged product requires a small local connector. GitHub CLI,
the repository, Claude Code/Codex, credentials, tools, and provider sessions
stay on each developer's machine. Telaegent cloud owns the browser product,
identity, project permissions, routing, approvals, shared conversations,
presence, safe audit, and compact shared memory.

The connector opens an outbound HTTPS/WebSocket connection. No LAN, peer-to-peer
link, inbound developer-machine port, cloud-hosted provider CLI, or cloud repo
checkout is part of the architecture.

## Durable versus private state

Durable shared state:

- project/repository identity
- project memberships and collaborator connections
- approved shared messages
- outbound approvals and safe audit events
- compact conversation memory for provider rehydration
- task IDs, opaque resource IDs and safe resource metadata, and capability
  grant/expiry/revocation events

Private/local state:

- GitHub/provider credentials and provider home directories
- repository checkout, local tool output, and provider sessions
- canonical local paths and the resource-ID mapping behind them
- rough drafts and clarification turns
- raw provider streams and temporary tool output

Provider sessions accelerate work but never replace Telaegent's durable shared conversation.

## Claims we do not make

- no claim that the web product works while the owning connector is offline
- no claim that local execution alone is a complete sandbox
- no zero-knowledge or end-to-end-encryption claim
- no direct collaborator filesystem access
- no automatic cross-user send
- no LLM-decided permission expansion; scope is deterministic code
- no automatic write capability in P0
- no capability reuse across a different task or peer
- no personal Claude/Codex history import
- no canonical LAN dependency

## Demo proof

The three-minute demo should show two users, one shared GitHub project, two different coding-agent providers, sender private preparation, sender approval, recipient repository-grounded investigation, one scope-expansion prompt answered with **Allow for this task**, a second request for the same file resolving automatically, recipient approval, and a safe `.env` reformulation with raw values never disclosed.
