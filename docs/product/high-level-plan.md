# Telaegent — High-Level Product Plan

## Current architecture revision — 2026-08-29

Two teammate proposals were reviewed:

- **Khoa:** cloud-hosted GitHub CLI + repository checkout + cloud Claude/Codex CLI. This is consistent with the current cloud-only product and is incorporated.
- **Thai:** cloud control plane + local developer connector using local repo/CLI. This is technically attractive, but it contradicts the current browser-first **everything required is cloud-hosted** decision. It is retained as a fallback architecture, not the canonical judged path.


**Status:** New canonical high-level product direction  
**Scope:** Product idea, user experience, trust model, and high-level architecture only  
**Implementation plan:** Intentionally deferred  
**Product name:** **Telaegent**

> **Current team note:** This document freezes the product direction, not the implementation.  
> Phuong and Khoa will co-own backend work. The five personal briefs in the accompanying ZIP are research/design assignments for the next phase and may change after their findings are reviewed.

---

## 1. Product in one sentence

**Telaegent is a project-scoped messaging and trust layer that lets one developer's coding agent communicate with another developer's coding agent, using each person's own connected GitHub repository and Claude Code/Codex runtime, while humans control what crosses between them.**

A shorter pitch:

> **Your agent can talk to my agent — but only about the project we both choose, and nothing crosses to the other side until a human approves it.**

The central product primitive is no longer a fixed conflict-detection workflow. The central primitive is **trusted, project-scoped agent messaging**.

Conflict detection, architecture discussions, implementation questions, dependency negotiation, debugging assistance, context requests, and other workflows can later be built on top of that messaging primitive.

---

## 2. Core product philosophy

Today, collaboration between coding agents is awkward:

```text
Developer A asks their agent
        ↓
Agent A produces an answer
        ↓
Developer A sends it to Developer B
        ↓
Developer B gives it to Agent B
        ↓
Agent B investigates
        ↓
Developer B sends the answer back
        ↓
Developer A gives it back to Agent A
```

Humans are acting as manual network adapters between agents that are already capable of understanding code, asking follow-up questions, reading repositories, and reasoning about technical work.

Telaegent removes that manual relay while preserving human control.

```text
Developer A
   ↓
Agent A
   ↓
Telaegent project channel
   ↓
Agent B
   ↓
Developer B
```

The important difference from unrestricted agent-to-agent communication is that **Telaegent inserts a visible trust boundary whenever information is about to cross from one person's side to another person's side.**

---

## 3. Major architectural decision: everything is cloud-hosted

The canonical Telaegent product remains **browser-first and cloud-hosted**.

There is **no required local connector, LAN worker, exposed local server, peer-to-peer connection, or requirement that the user's own laptop remain online**.

```text
                                  TELAEGENT CLOUD

Browser / React
      │
      ▼
Telaegent API / control plane
      │
      ├──────────────► Supabase: identity, projects, conversations,
      │                           approvals, audit, runtime metadata
      │
      └──────────────► isolated cloud agent runtimes
                         │
                         ├─ User A × Repo X
                         │   ├─ GitHub CLI authenticated as User A
                         │   ├─ Repo X checkout
                         │   ├─ Claude Code and/or Codex CLI
                         │   └─ Telaegent-created provider sessions
                         │
                         └─ User B × Repo X
                             ├─ separate GitHub identity
                             ├─ separate Repo X checkout
                             ├─ separate provider identity
                             └─ no visibility into User A's runtime
```

A fresh shell is only a **process boundary**, not an identity or filesystem boundary. The cloud runtime must deliberately isolate users/projects and deliberately persist only the auth/session/workspace state that should survive.

### 3.1 Why the local-connector alternative is not canonical

A local connector has real advantages:

- it can reuse the developer's already-authenticated local Claude/Codex CLI
- the repository does not need to be copied to Telaegent's cloud
- provider credentials stay on the user's machine
- multi-tenant agent-runtime isolation becomes much easier

However, it changes the product promise:

```text
browser-only cloud product
        ↓ becomes
install connector + keep developer machine/runtime available
```

That is a meaningful UX regression and contradicts the current product decision that **everything required for the judged flow lives in the cloud**.

Therefore the connector architecture is retained only as a **fallback architecture if cloud CLI authentication/isolation proves infeasible during implementation**. It is not the current plan.

### 3.2 Provisional cloud deployment direction

The current infrastructure hypothesis to validate is:

| Layer | Provisional choice |
| --- | --- |
| Frontend | React/Vite on Vercel |
| Backend/control plane | Node 22 + Fastify 5 behind Caddy on Azure |
| Database/Auth/Realtime | Supabase Postgres in Southeast Asia/Singapore |
| Agent execution | isolated cloud runtime per user × repository, provisioned on Azure compute/container infrastructure |
| Repository access | GitHub CLI authenticated inside the owning cloud environment |
| Coding providers | Claude Code CLI and/or Codex CLI authenticated inside the owning cloud environment |

The exact Azure runtime primitive is **not frozen yet**. A small VM may be sufficient for the two-user hackathon demo, but production-grade multi-tenant execution should not be claimed until isolation is proven.

---

## 4. Landing and onboarding

### 4.0 Telaegent user identity

Telaegent account identity and repository authorization are separate concepts.

The provisional cloud stack uses **Supabase Auth** for the Telaegent account. The exact sign-in method can be GitHub, email/magic-link, or another simple provider, but signing into Telaegent must not be confused with giving the cloud GitHub CLI permission to clone private repositories.

The product permission ladder is:

```text
Telaegent account identity
        ↓
GitHub CLI/repository authorization
        ↓
project-scoped collaborator connection
        ↓
private agent preparation
        ↓
per-outbound-message human confirmation
```

Default product rules:

- collaborator connection is approved **once per repository/project**, until revoked
- users do not re-approve the same collaborator for every ordinary message
- every cross-user agent-generated message still reaches a `Send / Edit / No` human gate
- obvious raw-secret classes may be denied even if a human tries to send them
- Repo A permission never implies Repo B permission

The landing page should remain minimal and visually restrained, similar in spirit to `x.ai/bot`, not an infrastructure dashboard.

### 4.1 Connect GitHub

For the hackathon, **a GitHub App is not required**.

The current preferred model is that each user's isolated cloud environment contains the official GitHub CLI authenticated as that user:

```text
User cloud environment
├─ GitHub CLI authenticated as this user
├─ Git credentials configured through GitHub CLI
├─ selected repository checkout(s)
├─ Claude Code CLI
└─ Codex CLI
```

Conceptual first connection:

```text
Connect GitHub
      ↓
start GitHub CLI browser/device authentication
      ↓
show user the GitHub authorization URL/code in Telaegent
      ↓
user authorizes once
      ↓
gh auth status succeeds
      ↓
gh auth setup-git
      ↓
repository discovery + clone
```

Candidate CLI path:

```bash
gh auth login --web --git-protocol https
gh auth status
gh auth setup-git
```

Important caveat: `gh auth login --web` is an interactive/browser flow, and GitHub CLI may store the resulting credential in a system credential store or fall back to a plaintext file when no credential store is available. Therefore Telaegent must **test the exact headless/container behavior before freezing the UX** and treat the resulting GitHub credential as sensitive cloud auth state.

Telaegent should not use `gh repo list` alone as its canonical "all repos I can work on" discovery mechanism. The authenticated-user repository API includes repositories the user owns, collaborates on, and can access through organization membership. Telaegent can invoke that API through `gh api` or another thin authenticated client.

The high-level rule remains:

> **A repository becomes a Telaegent project only when the user deliberately selects it and Telaegent proves the user's cloud GitHub identity can access it.**

Clone concept:

```text
authenticated GitHub identity
        ↓
selected repository
        ↓
gh repo clone OWNER/REPO <isolated workspace>
        ↓
Claude/Codex receives that workspace as cwd
```

Claude Code and Codex do not need their own GitHub integration. They need the authorized repository files in their working directory.

### 4.2 Connect a coding agent

The user must connect at least one of:

```text
Claude Code   [ Connect ]
Codex         [ Connect ]
```

They may connect both.

Telaegent does **not** integrate with the Claude consumer app conversation history or the Codex app as a product surface. Telaegent works directly with the **Claude Code CLI** and **Codex CLI** running in Telaegent's cloud environment.

Conceptually, connecting a provider means:

```text
Create/provision user's private cloud CLI environment
        ↓
Ensure CLI exists
        ↓
Authenticate the CLI for that user if needed
        ↓
Run a simple live probe
        ↓
Provider is marked connected
```

For example, the Claude connection probe can conceptually be:

```text
claude -p "Print exactly: TELAEGENT IS CONNECTED"
```

If that real model call succeeds, Telaegent knows that the environment is usable.

### Important wording

Telaegent should **not** claim that the provider never requires authentication.

The correct product statement is:

> **The user connects the CLI once. Telaegent does not require a new provider authorization for every message.**

After the user's cloud CLI environment is successfully connected, Telaegent can continue spawning CLI processes using that persisted provider identity until the provider requires re-authentication.

---

## 5. Claude Code/Codex sessions are not the user's personal chat history

Telaegent should deliberately isolate itself from the user's unrelated AI conversations.

The product should assume:

```text
User's personal Claude/Codex conversations
                    ✕
                    │
                    │ not imported into Telaegent
                    │
Telaegent-created CLI sessions
```

Telaegent starts its own Claude Code/Codex sessions inside the user's cloud project environment.

Claude Code explicitly supports resumable CLI sessions, including sessions created through non-interactive `claude -p` calls. Codex CLI also supports resumable CLI/thread sessions.

That gives Telaegent two useful behaviors:

```text
Fresh session
→ start a clean agent context

Continue session
→ resume a Telaegent-created project conversation
```

A newly spawned shell/process does **not** automatically imply a fresh conversation. Session continuity depends on whether Telaegent deliberately resumes the provider session and whether the user's CLI home/session storage persists.

---

## 6. Telaegent owns the durable collaboration memory

Provider sessions are useful, but **Telaegent should not make Claude/Codex session storage the canonical source of truth for the product**.

The durable source of truth is the Telaegent project conversation.

Example:

```text
Project: telaegent/backend
Participants: Phuong ↔ Justin

Phuong:
How does the auth middleware currently refresh tokens?

Justin's agent:
The current branch rotates the refresh token after...

Phuong:
Does that invalidate sessions on other devices?
```

Telaegent stores the approved shared conversation and enough project metadata to reconstruct the collaboration.

A provider session ID can be stored as an internal optimization so Telaegent can efficiently resume the agent's context:

```text
Telaegent project conversation
        = durable collaboration memory

Claude/Codex session
        = provider-specific working context/cache
```

This is important because provider sessions can disappear, expire, be compacted, or become unavailable. It also means a user can eventually switch providers without destroying the product's collaboration history.

For example:

```text
Monday: user uses Codex
Tuesday: user changes project agent to Claude Code

Telaegent still has the shared project conversation
        ↓
Claude can be hydrated with the relevant collaboration context
```

Telaegent therefore remains provider-neutral at the product level even though it directly runs provider CLIs.

---

## 7. Choose a repository before entering the collaboration product

After setup, the user chooses **which repository they are currently working in**.

The repository is the fundamental scope boundary.

Example:

```text
Choose a project

○ telaegent/backend
○ secret
○ DueLook
○ another-project
```

After selecting:

```text
Current project: telaegent/backend
```

Everything that follows is scoped to that project:

- available collaborators
- conversations
- agent context
- repository access
- permissions
- memory
- approvals
- audit events

A relationship established on Project A does **not** automatically authorize communication on Project B.

---

## 8. Project-scoped collaborator connections

Telaegent connections are scoped to a specific repository/project.

```text
Phuong ↔ Justin
on github.com/org/repo-a    ✓

Phuong ↔ Justin
on github.com/org/repo-b    ✕ unless separately connected
```

### 8.1 Do not make one user enumerate all GitHub collaborators

GitHub collaborator enumeration has permission edge cases, especially for organization repositories.

The cleaner MVP model is **mutual proof of repository access**:

```text
Phuong connects GitHub repo ID 123
Justin connects GitHub repo ID 123
        ↓
Telaegent knows both independently proved access
        ↓
they become eligible to discover/request each other on that project
```

Telaegent therefore does not need one developer to have admin-like permission to enumerate everyone who can access the repository.

Potential UX:

```text
People on Telaegent with access to this project

Justin   [Request to talk]
Khoa     [Connected]
Thai     [Pending]
```

For privacy, Telaegent may later require opt-in discoverability rather than exposing every matched account automatically.

### 8.2 Connection approval cadence

Current product decision:

```text
"Allow Phuong to communicate with me about Repo X?"
→ approve ONCE, revocable
```

After acceptance, normal project-scoped messages do **not** require a new collaborator-connection approval each time.

A different human gate still exists for actual disclosure:

```text
private agent prepares outbound content
        ↓
owning human reviews
        ↓
Send / Edit / No
```

So project connection grants the right to **request communication**, not the right to browse files or auto-send information.

---

## 9. The two conversation spaces

Telaegent has two fundamentally different conversational spaces.

### 9.1 Shared project conversation

This is what both collaborators can see.

```text
┌─────────────────────────────────────────┐
│ Project: telaegent/backend              │
│ Phuong ↔ Justin                         │
│                                         │
│ Phuong                                  │
│ How are refresh tokens handled?         │
│                                         │
│ Justin's Agent                          │
│ The current implementation rotates...  │
│                                         │
│ [ Write a message... ]                  │
└─────────────────────────────────────────┘
```

Only approved outbound messages appear here.

### 9.2 Private agent room

Before a message crosses to another person, Telaegent opens a private room between the user and their own selected coding agent.

This room can see:

- the relevant shared conversation
- the user's connected project repository
- the user's own current agent session/context
- the rough message the user is trying to send

It is **not visible to the collaborator**.

Important terminology:

> “Private” means private from the collaborator and other project participants. Because the product is cloud-hosted, it should not claim that this data is cryptographically inaccessible to the Telaegent service itself unless such a guarantee is actually implemented later.

---

## 10. Outbound message flow

Suppose Phuong types:

> `can u send me ur .env`

This text should **not immediately enter the shared conversation**.

Instead Telaegent opens the private agent room.

```text
┌─────────────────────────────────────────────────┐
│ Private with your Codex                         │
│ Project: telaegent/backend                      │
│ Recipient: Justin                               │
│                                                 │
│ You:                                            │
│ can u send me ur .env                           │
│                                                 │
│ Codex:                                          │
│ That would likely contain credentials.          │
│ Do you actually need the secret values, or      │
│ only the environment-variable names/config?     │
│                                                 │
│ You:                                            │
│ only the names                                  │
│                                                 │
│ Codex:                                          │
│ Proposed message:                               │
│                                                 │
│ “Can you send me the environment variable       │
│ names required by this project, without any     │
│ secret values?”                                 │
│                                                 │
│                    [ Edit ] [ No ] [ Send ]     │
└─────────────────────────────────────────────────┘
```

The agent's responsibility is to decide when it has produced a useful **send-ready candidate**.

The agent does **not** decide whether the message crosses the trust boundary.

The human does.

```text
Agent: READY TO SEND
        ↓
Human: Yes / No / Edit
        ↓
Only Yes sends to collaborator
```

This is a central product interaction and should be visually memorable.

---

## 11. Recipient-side flow is symmetrical

Justin receives the approved project message:

> “Can you send me the environment variable names required by this project, without any secret values?”

Justin's own selected coding agent can now privately investigate his connected repository.

```text
Shared request
     ↓
Justin's private agent room
     ↓
Agent inspects Justin's project workspace
     ↓
Agent reasons / asks Justin clarifying questions if required
     ↓
Agent prepares a response
     ↓
Justin sees final outbound candidate
     ↓
Justin chooses Send / Edit / No
```

Example:

```text
Claude:
I found these required variable names:

DATABASE_URL
REDIS_URL
JWT_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET

I did not include any values.

Send this response to Phuong?

[ Edit ] [ No ] [ Send ]
```

Only after Justin approves does it enter the shared project conversation.

The trust model is therefore symmetrical:

```text
Phuong's private side
        ↓
Phuong approves outbound message
        ↓
══════════ TRUST BOUNDARY ══════════
        ↓
Shared project conversation
        ↓
Justin's private side
        ↓
Justin approves outbound response
        ↓
══════════ TRUST BOUNDARY ══════════
        ↓
Shared project conversation
```

---

## 12. Human approval is necessary, but some things should still be impossible to send raw

The product should not treat human approval as the only safety mechanism.

There are certain classes of information where Telaegent should have deterministic protection underneath the AI.

Examples:

```text
.env and .env.*
private keys
API tokens
access tokens
cloud credentials
SSH credentials
known credential files
```

If Justin's agent finds a raw `.env`, the correct experience is not:

```text
Here is your AWS_SECRET_ACCESS_KEY...

[ Send ]
```

Instead:

```text
Raw .env sharing is protected.

I can provide:
✓ variable names
✓ safe configuration structure
✓ documentation
✕ secret values
```

This produces a strong product principle:

> **The AI decides what would be useful. The human decides whether to communicate. Telaegent still enforces hard boundaries around obvious secrets and project scope.**

---

## 13. Messaging permission and repository permission are different

Accepting another person as a Telaegent collaborator for a project means:

```text
They may send project-scoped agent messages to me. ✓
```

It does **not** mean:

```text
They may directly browse my connected repository. ✕
```

The recipient's own agent may inspect the recipient's repository privately in order to answer a question.

The remote collaborator receives only the final content the recipient approves for sharing.

This distinction is essential.

```text
Remote user
   │
   │ can ask
   ▼
Recipient's agent
   │
   │ can inspect recipient's repo privately
   ▼
Recipient human
   │
   │ approves outbound content
   ▼
Remote user
```

No collaborator is granted a general remote filesystem interface simply because a project connection exists.

---

## 14. Provider choice

A user may connect:

```text
Claude Code only
Codex only
Both
```

If both are connected, Telaegent may let the user choose which coding agent represents them for a particular project or conversation.

Example:

```text
Project agent

● Claude Code
○ Codex
```

Provider choice is a user preference, not a project trust decision.

The shared conversation should remain provider-neutral:

```text
Phuong — Codex
Justin — Claude Code
```

This can actually strengthen the demo because it shows that Telaegent is the layer connecting separately owned agents rather than being tied to one AI vendor.

---

## 15. High-level memory model

Telaegent should distinguish at least three kinds of context.

### 15.1 Shared project memory

Durable and visible to both participants:

- approved sent messages
- approved received messages
- project/repository identity
- participant identities
- timestamps
- relevant safe message metadata

This is the canonical collaboration record.

### 15.2 Private user-agent working context

Visible only to the owning user within Telaegent:

- rough drafts
- clarification questions
- local project reasoning/context
- agent-prepared outbound candidates

The exact retention policy for these private deliberation sessions is still an open product decision. A privacy-minimizing MVP should avoid treating full private agent transcripts as permanent collaboration history.

### 15.3 Provider session state

Claude Code/Codex session identifiers and provider-specific working state.

These exist to make conversations faster and more coherent, but are not the product's durable source of truth.

If a provider session becomes unavailable, Telaegent should be able to start a new provider session using the relevant project and Telaegent conversation context.

---

## 16. Project scope must include repository version context

Two developers can be talking about “the same repository” while their code is not actually identical.

Therefore every project conversation should understand at least:

```text
repository
branch
commit / revision
```

For example:

```text
Phuong
repo: telaegent/backend
branch: feat/auth-ui
commit: abc123

Justin
repo: telaegent/backend
branch: feat/auth-service
commit: def456
```

This context can remain subtle in the UI, but agents need it to avoid answering questions as if both sides have identical code.

The user should be able to ask:

> “How does your branch currently implement session refresh?”

rather than receiving an ambiguous answer about an unspecified repository state.

---

## 17. High-level cloud isolation requirement

The minimum conceptual execution boundary is:

```text
USER × REPOSITORY
```

Example:

```text
User A × Repo X
┌────────────────────────────────────┐
│ isolated workspace                 │
│ Repo X checkout                    │
│ provider session state for Repo X  │
│ temporary agent/tool output        │
└────────────────────────────────────┘

User B × Repo X
┌────────────────────────────────────┐
│ separate workspace                 │
│ separate provider runtime          │
│ no visibility into User A          │
└────────────────────────────────────┘
```

User-level credentials such as GitHub/Claude/Codex authorization may be stored in a protected user credential layer and mounted/injected only into that user's runtimes. The exact implementation is an infrastructure decision; the trust requirement is not.

A new shell does not isolate `$HOME`. Telaegent must deliberately control:

- GitHub CLI auth state
- Git credential-helper state
- Claude Code auth/config/session state
- Codex auth/config/session state
- repository checkout
- provider-created caches
- temporary files
- environment variables
- logs
- process/network boundaries

For the hackathon:

- controlled demo accounts and repositories are acceptable
- one cloud host may physically run multiple isolated containers if necessary
- we must not claim production-grade multi-tenant security until proven
- no remote user may supply another user's absolute workspace path
- no cross-user filesystem mount is allowed
- secret-bearing blocked output should not be persisted

---

## 18. High-level trust model

Telaegent has three major permission boundaries.

### Boundary 1 — Repository access

> Which repositories has the user deliberately connected to Telaegent?

GitHub controls the source repository relationship.

### Boundary 2 — Project relationship

> Which people may communicate with me through agents about this repository?

A collaborator request must be accepted for the specific project.

### Boundary 3 — Outbound information

> What am I actually willing to send this collaborator right now?

The user's private agent prepares the response. The human approves the outbound candidate. Hard secret/project rules remain enforceable underneath that approval.

This can be explained very simply in a pitch:

```text
Connect the repo.
Connect the person.
Approve what leaves your side.
```

---

## 19. What Telaegent should store

### 19.1 Supabase / product database

Store durable product state such as:

- Telaegent user identity
- selected GitHub repository identity and stable repository ID
- project membership / proof-of-access metadata
- project-scoped collaborator connection requests and decisions
- shared project conversations
- approved shared messages
- safe provider connection status
- runtime/project metadata
- send/approval events
- audit events
- conversation memory/summary needed for provider rehydration

### 19.2 Protected cloud credential/runtime storage

Store only what is required for the owning user's runtime, with a stronger security posture than ordinary product rows:

- GitHub CLI authorization state or equivalent secret
- Claude/Codex CLI authorization state
- provider session references/state when required
- repository checkout/cache
- runtime configuration

These must never be exposed through normal product APIs.

### 19.3 Ephemeral by default

Prefer not to durably store:

- raw CLI streams
- temporary tool output
- raw rejected drafts
- transient build artifacts
- internal prompts
- hidden reasoning

### 19.4 Never intentionally store/share

- raw blocked `.env` values
- private keys
- access tokens copied from repositories
- another user's private draft transcript
- unrelated repository contents
- hidden chain-of-thought

---

## 20. Main product screens

### 20.1 Landing

Minimal hero and product preview.

```text
Telaegent

Your coding agent can talk to your teammate's coding agent.
Without handing over your whole workspace.

[ Get started ]
```

### 20.2 Connections

```text
GitHub       Connected
Claude Code  Connected
Codex        Not connected
```

### 20.3 Project selector

```text
Your projects

Telaegent          Open
DueLook            Open
Secret             Open
```

### 20.4 Project home

```text
Telaegent

Collaborators
Justin      Connected
Khoa        Connect
Thai        Connect

Recent conversations
Justin      Auth/session architecture
Khoa        Backend API contract
```

### 20.5 Shared conversation

Normal messaging interface, but messages are project-scoped and agent-assisted.

### 20.6 Private send/reply room

The signature interaction where the user's own agent clarifies, investigates, and prepares an outbound message before the user approves it.

---

## 21. Canonical end-to-end user flow

### Step 1 — Sign in

User opens Telaegent and creates/logs into a Telaegent account.

### Step 2 — Connect GitHub

User grants Telaegent access to the repository or repositories they want to use.

### Step 3 — Connect an agent

User connects Claude Code, Codex, or both.

Telaegent verifies the cloud CLI can make a real request.

### Step 4 — Choose project

User chooses a connected GitHub repository.

### Step 5 — Find collaborator

Telaegent shows available collaborators for that project.

### Step 6 — Request project connection

User asks to connect with another developer for that repository.

### Step 7 — Recipient accepts

The other developer explicitly accepts the project-scoped relationship.

### Step 8 — User writes rough request

Example:

> `ask justin why the auth service is using redis here`

### Step 9 — Private agent prepares message

The user's coding agent can inspect their own project context, review the shared thread, and ask the user clarifying questions.

It eventually proposes a clean outbound message.

### Step 10 — Human approves

User chooses:

```text
Send / Edit / No
```

### Step 11 — Message enters shared project conversation

Only now does Justin see it.

### Step 12 — Justin's agent privately investigates

Justin's agent can inspect Justin's connected repository and reason about the answer.

### Step 13 — Justin approves the response

Justin sees the proposed outbound response and chooses Send/Edit/No.

### Step 14 — Response enters shared conversation

Phuong now receives the repository-grounded response.

### Step 15 — Conversation continues

Each additional cross-user message follows the same trust boundary.

---

## 22. Recommended hackathon demo

The demo should prove the product in under three minutes without trying to demonstrate a generic enterprise platform.

### Setup

- Two Telaegent accounts
- Same GitHub project
- Two different branches/revisions if useful
- User A connected to Codex
- User B connected to Claude Code
- Project connection already accepted or accepted live

### Demo Part A — the useful wow moment

Phuong asks:

> “Ask Justin's agent how the current auth service refreshes sessions and what my branch needs to call.”

Phuong's Codex privately refines the question.

Phuong approves.

Justin receives it.

Justin's Claude Code inspects Justin's connected branch, prepares a repository-grounded answer, and Justin approves it.

The answer appears in the shared project conversation.

This proves:

- real agent-to-agent collaboration
- cross-provider communication
- project scope
- repository context
- human control

### Demo Part B — the trust moment

Phuong asks:

> `can u send me ur .env`

His private agent recognizes the likely intent and asks whether he needs values or only variable names.

Phuong says only names.

The agent proposes a safer request and Phuong sends it.

Justin's agent inspects the project but Telaegent prevents raw `.env`/secret disclosure and proposes a sanitized answer containing only variable names.

Justin approves.

The sanitized result crosses back.

This proves that Telaegent is not merely “Slack where the users are AI.” It is a **trust boundary for agent collaboration**.

---

## 23. What the MVP is NOT

The first hackathon version should not try to become:

- a replacement for GitHub
- a new coding model
- a new IDE
- a general Slack replacement
- an autonomous multi-agent swarm
- a shared filesystem between developers
- a way to import users' complete Claude/Codex history
- automatic code merge infrastructure
- a full enterprise access-control platform
- a system that allows one collaborator to remotely control another person's coding agent without review

The core product is much smaller:

> **Project-scoped, human-gated messaging between coding agents that can privately inspect their owner's repository.**

---

## 24. Important open decisions

These are intentionally left unresolved until the implementation plan is written.

### 24.1 GitHub cloud-auth mechanics

Current direction: authenticate the GitHub CLI inside the user's cloud environment and reuse that credential for Git operations.

Still to validate:

- whether `gh auth login --web` can be bridged cleanly from a headless runtime into the Telaegent browser
- whether parsing the CLI's browser/device-code output is robust enough
- whether an app-owned OAuth/device-flow implementation with `GH_TOKEN` would be cleaner later
- secure credential persistence when no OS keychain exists
- organization SSO / restricted-organization behavior
- repository discovery through authenticated-user API rather than `gh repo list` alone

A GitHub App is **not required for the P0 architecture**, though it remains a possible future production authorization model.

### 24.2 Provider connection mechanics

The product behavior is clear — connect once, verify with a live CLI call, persist provider connection state — but the exact cloud credential/session provisioning mechanism should be designed separately.

### 24.3 Private-agent transcript retention

Decide whether private drafting conversations are:

- ephemeral
- retained for a short period
- permanently available only to the owning user

The shared project conversation should remain the durable collaboration record regardless.

### 24.4 Repository synchronization

Decide when Telaegent refreshes a connected project workspace from GitHub and how branch selection works.

### 24.5 Message attachments / source snippets

The MVP may begin with text-only approved messages. File excerpts and structured attachments can be added only if the trust boundary remains obvious.

### 24.6 Low-risk auto-send in the future

The hackathon should keep explicit human approval for outbound cross-user messages. A later product could allow users to pre-authorize low-risk categories or a bounded conversation window, but this should not complicate the first demo.

---

## 25. Main risks and flaws to watch

### 25.1 Cloud hosting transfers security responsibility to Telaegent

The old local architecture kept repositories and provider identities on users' own machines. The new product is dramatically easier to use, but Telaegent now becomes responsible for isolating cloud repository copies and provider credentials.

This is the largest technical/security tradeoff in the redesign.

For the hackathon, use controlled demo repositories/accounts and be honest that production would require hardened multi-tenant isolation and credential storage.

### 25.2 A new shell is not automatically a new agent identity or conversation

Spawning `claude -p` or `codex exec` in a fresh process does not automatically erase session state if the same CLI home is reused.

Telaegent must deliberately choose whether each operation creates or resumes a provider session.

### 25.3 Provider sessions must not become the only memory layer

If the product depends entirely on one provider's local session file, session loss or provider switching can destroy continuity.

Telaegent's shared project history must remain canonical.

### 25.4 “Private” must be explained precisely

Private agent drafting is private from the collaborator, not necessarily from the Telaegent cloud operator.

Do not make end-to-end-encryption claims that have not actually been implemented.

### 25.5 Human approval alone is not enough for obvious secrets

A user can accidentally approve something dangerous.

Deterministic blocks for raw secrets are still worthwhile even in a human-gated system.

### 25.6 Repository relationship does not imply unrestricted source access

A collaborator should be able to ask a question. They should not gain a hidden remote filesystem API into another user's repo.

The recipient's own agent performs local-in-that-user's-cloud-workspace inspection and the owner approves the outbound answer.

### 25.7 Provider terms and cloud automation need production review

Running per-user Claude Code/Codex CLI environments as a hosted product is different from a developer personally running the CLI on a laptop. Before production, Telaegent must verify provider terms, subscription/automation policies, rate limits, and supported authentication patterns.

This does not invalidate the hackathon prototype, but it should be treated as a real commercialization question.

### 25.8 Repo collaborator discovery can be messy

Do not assume `gh repo list` or a repository-collaborator endpoint solves this universally. Repository access can come from ownership, direct collaboration, or organization/team membership, and collaborator enumeration may require privileges an ordinary contributor does not have.

P0 should match Telaegent users by **independent proof that each connected the same GitHub repository ID**, then allow a project-scoped connection request.

### 25.9 `gh auth login` inside a cloud container is still sensitive authorization

Using the GitHub CLI avoids building a GitHub App for P0, but it does not remove authorization. The cloud environment will possess a credential capable of reading the user's selected/private repositories.

GitHub CLI can store credentials in the system credential store, but if that is unavailable it may fall back to plaintext-file storage. Production must not casually persist that file in an ordinary shared volume.

### 25.10 Cloud CLI authentication remains the largest unresolved implementation gate

The product requires each user's Claude Code/Codex identity to work inside an isolated cloud runtime and survive new processes without leaking to other users.

Before broad implementation, prove:

```text
authenticate once
→ new process still works
→ provider session can resume
→ credential/session is isolated
→ runtime can be destroyed/recreated or recovered safely
```

---

## 26. Why this direction is stronger than the previous product structure

The previous design encoded one large workflow as the product:

```text
publish intent
→ detect conflict
→ status exchange
→ proposal
→ dual approval
→ ContextPack
→ dependency change
→ replan
→ audit
```

Those ideas were useful, but the workflow was too specific to be the fundamental abstraction.

The new Telaegent abstraction is much smaller:

```text
PROJECT
   ↓
PEOPLE
   ↓
THEIR AGENTS
   ↓
PRIVATE PREPARATION
   ↓
HUMAN-GATED MESSAGE
   ↓
SHARED PROJECT CONVERSATION
```

Now conflict negotiation can still happen — but as one conversation use case.

Architecture questions can happen.

Debugging can happen.

Dependency coordination can happen.

Onboarding questions can happen.

Code review questions can happen.

The product no longer has to predict the workflow. The agents and humans use the messaging primitive to perform whatever project collaboration is needed.

That makes the idea both more general and easier to explain.

---

## 27. Core product principles to preserve

If implementation details change later, these principles should survive:

1. **Telaegent is cloud-first.** No local worker or LAN dependency is required for the product experience.
2. **GitHub repository is the project boundary.**
3. **A collaborator relationship is project-scoped, never global by default.**
4. **Users bring Claude Code, Codex, or both.**
5. **Telaegent runs provider CLIs rather than pretending to be the coding model itself.**
6. **Personal Claude/Codex app histories are not part of Telaegent.**
7. **Telaegent-created project conversations are the durable collaboration memory.**
8. **Provider sessions are resumable working context, not the source of truth.**
9. **Every cross-user message is prepared privately first.**
10. **The agent may decide a draft is ready; only the human decides to send it.**
11. **The recipient side follows the same rule.**
12. **Project connection allows communication, not unrestricted repository access.**
13. **Obvious secrets remain protected even when an AI or human makes a bad suggestion.**
14. **Different providers should be able to collaborate through the same Telaegent project channel.**
15. **The product should feel like messaging, not like operating infrastructure.**

---

## Companion research briefs

This repository also contains five self-contained next-phase briefs under [`docs/team/`](../team/):

- [`khoa.md`](../team/khoa.md) — backend, GitHub, repository/collaborator access, user authorization and trust
- [`thai.md`](../team/thai.md) — cloud deployment, runtime isolation, database/storage, cost and latency
- [`duy.md`](../team/duy.md) — complete frontend/product UX from landing through private/shared conversations
- [`hien.md`](../team/hien.md) — agent protocol experiments, API/prompt format evaluation, security/leakage tests and test architecture
- [`phuong.md`](../team/phuong.md) — backend co-ownership, Claude Code/Codex CLI runtimes, provider sessions, Telaegent memory and integration

These are investigation/design responsibilities, not irreversible implementation boundaries.

---

# 28. Product assessment

## Product idea rating — **9.2 / 10**

The strongest part of Telaegent is that the problem is extremely easy to recognize once demonstrated:

> Developers already use coding agents independently, but collaboration still requires humans to manually copy information from one agent to another.

Telaegent creates a new collaboration layer between separately owned agents without pretending that the agents should be fully autonomous or mutually trusted.

The private-agent → human approval → shared-project-message interaction is the most distinctive part of the idea.

It is simple enough to explain and deep enough to extend into many workflows later.

## Hackathon idea rating — **9.5 / 10**

This is particularly strong for a hackathon because the “wow” moment is visible.

A judge can literally watch:

```text
Codex on User A
        ↓
project-scoped request
        ↓
human approval
        ↓
Claude Code on User B
        ↓
real repository investigation
        ↓
human approval
        ↓
answer appears for User A
```

That is much easier to appreciate than a backend-heavy orchestration system whose most impressive work is hidden in state machines.

The `.env` example adds a second memorable moment by demonstrating why Telaegent is more than simply connecting two chatbots.

## Pitch clarity — **9.7 / 10**

The product can be explained in one sentence:

> “My coding agent can directly ask your coding agent questions about the repo we're working on, but you control what your side sends back.”

That is excellent hackathon pitch material.

## Differentiation — **9.0 / 10**

There are many agent frameworks, coding agents, team chat products, and AI coding tools.

Telaegent's differentiated layer is not “another agent.”

It is:

> **identity + project scope + private agent reasoning + human-gated agent-to-agent communication.**

The product becomes especially interesting when the two users use different coding-agent providers.

## Technical feasibility for a hackathon — **7.5 / 10**

The happy path is very buildable:

- web app
- two users
- one GitHub repo
- one connected provider per user
- cloud workspace
- project invite/acceptance
- shared conversation
- private draft popup
- CLI invocation
- human approval

The difficult parts are not the messaging UI. They are provider authentication in hosted environments, multi-user workspace isolation, safe credential handling, and making live CLI execution reliable during a demo.

The hackathon should optimize for one extremely polished vertical slice rather than production-grade infrastructure.

## Security/product-risk rating — **6.5 / 10 today, potentially 9 / 10 with production hardening**

The cloud-first redesign improves UX but makes Telaegent the custodian of sensitive things: source code and provider authorization state.

That is the biggest cost of the new architecture.

For a hackathon this is manageable with controlled demo accounts and repositories. For a real product, isolation, encrypted credential storage, access control, logging discipline, retention, revocation, and provider-policy review become first-class work.

## Long-term product potential — **8.8 / 10**

The primitive generalizes well.

Once project-scoped agent messaging exists, future features could include:

- delegated code questions
- cross-branch coordination
- implementation-plan negotiation
- dependency alerts
- agent-assisted code review conversations
- automatic context packaging
- issue/PR-scoped agent rooms
- bounded auto-negotiation policies
- team knowledge exchange
- organization-level agent directories

The previous conflict/ContextPack/replan concept can return later as a higher-level workflow built on top of the messaging layer rather than being hardcoded as the whole product.

## Biggest strategic advantage

Telaegent does not need to beat Claude Code or Codex.

It benefits when coding agents become more powerful and more widely adopted.

The product sits **between independently owned agents**, solving the collaboration problem created by their adoption.

That is a much better strategic position than trying to build another general coding agent.

## Biggest strategic threat

Claude, OpenAI, GitHub, or another platform could eventually build native cross-user/project agent collaboration into their own ecosystem.

Telaegent's defense would need to be:

- cross-provider neutrality
- strong project/team identity
- trust and approval UX
- excellent GitHub/project integration
- auditability
- collaboration workflows that work regardless of which agent each teammate uses

## Final assessment

**I would build this version for the hackathon.**

It is clearer, more memorable, easier to demo, and has a more general product primitive than the previous architecture.

The highest priority is not adding more autonomous behavior. It is making one interaction feel magical and trustworthy:

> **I ask my agent to ask your agent something about our project. My agent privately helps me formulate the request. I approve it. Your agent investigates your side. You approve the answer. I get useful, repository-grounded context without either of us manually copy-pasting between agents.**

If that experience works smoothly with two real users, one real GitHub repository, and two real coding-agent CLIs, Telaegent already has a compelling hackathon demo.
