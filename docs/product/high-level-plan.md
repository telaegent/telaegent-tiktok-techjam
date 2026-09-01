# Telaegent — High-Level Product Plan

## Current architecture revision — 2026-08-30

The runtime-location decision is final:

- **Local on each developer machine:** selected repository/worktree, Git and
  GitHub CLI, Claude Code, Codex, provider credentials, provider homes and
  sessions, file inspection, tools, tests, and a small Telaegent connector.
- **Telaegent cloud:** browser product, backend/control plane, identity,
  project permissions, connector presence and job routing, approvals, shared
  conversations, safe audit, and compact shared project memory.

Browser-first does not mean cloud agent execution. Telaegent cloud is the
coordination plane and message relay; it does not host provider CLIs or user
repository checkouts.


**Status:** New canonical high-level product direction  
**Scope:** Product idea, user experience, trust model, and high-level architecture only  
**Implementation plan:** [`canonical-build-plan.md`](canonical-build-plan.md)  
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

## 3. Major architectural decision: cloud coordination, local execution

The canonical Telaegent product remains **browser-first and cloud-hosted**, but
GitHub and coding-agent execution are local. A small local connector is the
only new developer-machine component.

There is no LAN worker, exposed local server, peer-to-peer connection, or
inbound developer-machine port. The connector opens an outbound secure
connection to Telaegent, and the owning developer machine must be online for
local agent work.

```text
Developer A                         Developer B
LOCAL                               LOCAL
repo + gh + Claude/Codex            repo + gh + Claude/Codex
Telaegent connector                 Telaegent connector
       │                                   │
       └──────── outbound secure ──────────┘
                         │
                         ▼
                  TELAEGENT CLOUD
             browser + API + Supabase
         routing + auth + approvals + audit
```

A fresh shell is only a **process boundary**, not an identity or filesystem
boundary. The local connector must deliberately bind each job to one registered
user × repository workspace and the correct local provider identity. The cloud
stores only an opaque connector binding and safe status/metadata; it never
stores or chooses a local path.

### 3.1 Deployment

The deployed shape is:

| Layer | Choice |
| --- | --- |
| Frontend | React/Vite, served by the control plane on one origin |
| Backend/control plane | Node 22 + Fastify 5 behind Caddy on AWS EC2 |
| Database/session persistence/Realtime | Supabase Postgres in Southeast Asia/Singapore |
| Connector presence/job relay | AWS EC2 backend using outbound WebSocket, long-polling, or equivalent |
| Agent execution | local connector binding per user × repository |
| Repository access | developer's local Git/GitHub CLI state |
| Coding providers | developer's locally authenticated Claude Code CLI and/or Codex CLI |

The connector transport is outbound long-polling. The control plane does not
provision provider runtimes. Connector pairing, local repository proof, job
delivery and the human-gated message flow have been exercised against the live
deployment. Production-grade multi-tenant isolation and revocation under
adversarial conditions remain unproven and should not be claimed.

---

## 4. Landing and onboarding

### 4.0 Telaegent user identity

Telaegent account identity and repository authorization are separate concepts.

The cloud product uses **GitHub OAuth** to establish the Telaegent account, then
issues its own opaque, revocable browser session. Supabase is persistence only;
Supabase Auth JWTs are not a Telaegent identity credential. The OAuth token is
used only to fetch the stable GitHub user identity and is not persisted.
Signing into Telaegent must not be confused with the developer's local GitHub
CLI identity and repository-access proof.

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

The connector uses the official GitHub CLI already installed and authenticated
on the developer's machine:

```text
Developer machine
├─ selected local repository/worktree
├─ GitHub CLI authenticated as this user
├─ Claude Code CLI and/or Codex CLI
└─ Telaegent connector bound to this user × repository
```

Conceptual first connection:

```text
Connect GitHub
      ↓
run local Git and GitHub CLI checks
      ↓
if unauthenticated, user signs in locally
      ↓
connector proves access to selected local repository
      ↓
register stable repository ID + safe branch/commit metadata
```

Candidate CLI path:

```bash
gh auth status
git remote get-url origin
git rev-parse HEAD
git branch --show-current
```

If `gh auth status` fails, Telaegent tells the user to authenticate GitHub CLI
locally. Telaegent cloud never runs `gh auth login`, receives the resulting
credential, or clones the repository.

Telaegent should not use `gh repo list` alone as its canonical "all repos I can work on" discovery mechanism. The authenticated-user repository API includes repositories the user owns, collaborates on, and can access through organization membership. Telaegent can invoke that API through `gh api` or another thin authenticated client.

The high-level rule remains:

> **A repository becomes a Telaegent project only when the user deliberately
> selects it locally and their connector proves that the local GitHub identity
> can access the stable repository ID.**

Clone concept:

```text
authenticated GitHub identity
        ↓
selected local repository
        ↓
connector registers an opaque user × repository binding
        ↓
connector resolves that registered local workspace as the provider cwd
```

Claude Code and Codex do not need their own GitHub integration. They receive
the selected local repository as their working directory. The cloud job never
contains that local path.

### 4.2 Connect a coding agent

The user must connect at least one of:

```text
Claude Code   [ Connect ]
Codex         [ Connect ]
```

They may connect both.

Telaegent does **not** integrate with the Claude consumer app conversation history or the Codex app as a product surface. The local connector works directly with the developer's locally installed **Claude Code CLI** and **Codex CLI**.

Conceptually, connecting a provider means:

```text
Start connector for the selected local repository
        ↓
Detect the local CLI
        ↓
Use the developer's existing local authentication
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

After the local CLI passes the probe, the connector can continue spawning local
CLI processes using that local provider identity until the provider requires
the developer to re-authenticate locally.

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

The connector starts Telaegent-specific Claude Code/Codex sessions inside the
user's local project environment.

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

> “Private” means private from the collaborator and other project participants.
> A draft may transit Telaegent cloud to support the browser UI, so the product
> should not claim zero knowledge or end-to-end encryption unless implemented.
> Repository contents, credentials, raw provider context, and provider sessions
> remain local and are not part of that transit.

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

## 17. High-level local execution isolation requirement

The minimum conceptual execution boundary is:

```text
USER × REPOSITORY
```

Example:

```text
User A × Repo X
┌────────────────────────────────────┐
│ registered local workspace         │
│ local Repo X checkout/worktree     │
│ local provider session for Repo X  │
│ local temporary agent/tool output  │
└────────────────────────────────────┘

User B × Repo X
┌────────────────────────────────────┐
│ separate registered workspace      │
│ separate local provider binding    │
│ no visibility into User A          │
└────────────────────────────────────┘
```

GitHub/Claude/Codex authorization stays in the developer's local credential
stores and is never mounted into or injected by Telaegent cloud. The connector
uses it only on the owning developer's machine.

A new shell does not isolate `$HOME`. The local connector must deliberately control:

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
- each developer runs their own local connector
- the cloud job contains an opaque connector binding, never an absolute path
- connector registration and job dispatch reject cross-project bindings
- no inbound public port or peer-to-peer connection is required
- secret-bearing blocked output should not be persisted

---

## 18. High-level trust model

Telaegent has three major permission boundaries, plus a task-scoped narrowing
of the third.

### Boundary 1 — Repository access

> Which repositories has the user deliberately connected to Telaegent?

GitHub controls the source repository relationship.

### Boundary 2 — Project relationship

> Which people may communicate with me through agents about this repository?

A collaborator request must be accepted for the specific project.

### Boundary 3 — Outbound information

> What am I actually willing to send this collaborator right now?

The user's private agent prepares the response. The human approves the outbound candidate. Hard secret/project rules remain enforceable underneath that approval.

### Narrowing Boundary 3 — task-scoped capability

> What did I already agree to share for this specific piece of work?

Boundary 3 may be narrowed and reused inside one task, never widened. When an
owner approves a set of files for a task, their agent may serve later requests
for those exact files, from that same peer, read-only, without interrupting the
owner again. Anything outside that set returns to the human.

Full specification in [canonical build plan section 8](canonical-build-plan.md).
This is now working product behaviour: task and grant records, cloud route
authorization, the local registry and file broker, the deterministic policy,
the scope-expansion queue, resource transfer through the relay, and the
bounded follow-up rounds all exist in the server and the connector.

What is missing is the owner-facing surface. The decision is recorded and
enforced, but no screen presents it yet, so an owner answers a scope request
through the API rather than the dialog in section 8.1. The loop has also not
been evaluated against a live provider.

The rule underneath it:

> An agent may consume or narrow authority a human already delegated. It may
> never autonomously broaden that authority.

Two things this never relaxes: the LLM is not the authorization authority, and
a final cross-user message still crosses only on the owner's `Send`.

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
- task IDs, opaque resource IDs, and safe resource metadata
- capability grant, expiry, revocation, and scope-decision events

### 19.2 Local-only connector/runtime state

Keep on the owning developer machine:

- GitHub CLI authorization state
- Claude/Codex authorization and provider home directories
- provider session references/state
- repository checkout/worktree and local caches
- connector mapping from opaque binding ID to local workspace/provider
- connector mapping from opaque resource ID to canonical local path

These must never be uploaded to Telaegent cloud or exposed through product APIs.

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

### 20.7 Scope-expansion approval

Shown when a collaborator's agent needs a file the owner has not yet granted
for this task. It must state the file, the reason, and the access level, and
offer three answers:

```text
B's agent needs:
src/settings.ts

Reason:
"LandingPage.tsx imports configuration from this file."

Permission:
READ ONLY

[Deny] [Allow once] [Allow for this task]
```

**Allow for this task** adds that one file to the task's read-only scope, so
later requests for it resolve without interrupting the owner again. The UI must
say plainly that this covers later versions of that file for the life of the
task, and that the grant ends with the task or on revocation.

---

## 21. Canonical end-to-end user flow

### Step 1 — Sign in

User opens Telaegent and creates/logs into a Telaegent account.

### Step 2 — Connect GitHub

User grants Telaegent access to the repository or repositories they want to use.

### Step 3 — Connect an agent

User connects Claude Code, Codex, or both.

The local connector verifies the local CLI can make a real request.

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

### Step 13 — Justin's agent asks for a file it does not own

Justin's agent needs `LandingPage.tsx` from Phuong's side. Nothing is granted
yet, so Phuong is asked and chooses **Allow for this task**. The agent then
needs `settings.ts`; that is a second question, and Phuong answers it the same
way. When the agent comes back to `LandingPage.tsx` later in the same task, it
resolves with no prompt.

How the first grant of a task is made - attached at send time, or asked for on
first request as shown here - is [24.7](#247-capability-scope-mechanics).

### Step 14 — Justin approves the response

Justin sees the proposed outbound response and chooses Send/Edit/No.

### Step 15 — Response enters shared conversation

Phuong now receives the repository-grounded response.

### Step 16 — Conversation continues

Each additional cross-user message follows the same trust boundary. Capability
grants do not: they end with the task or on revocation.

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
- arbitrary remote filesystem browsing of a collaborator's machine
- a system where the LLM decides that a new file is related enough to access
- automatic write access to another developer's files

The core product is much smaller:

> **Project-scoped, human-gated messaging between coding agents that can privately inspect their owner's repository, and that may collaborate autonomously only inside capabilities a human already granted.**

---

## 24. Important open decisions

These are intentionally left unresolved until the implementation plan is written.

### 24.1 Local GitHub proof mechanics

Current direction: use the developer's existing local Git/GitHub CLI state and
register only safe repository metadata.

Still to validate:

- exact stable repository-ID proof from a selected local remote
- organization SSO / restricted-organization behavior
- handling repositories without a GitHub remote
- revalidation and revocation while the connector is offline
- safe repository registration without uploading local paths

A GitHub App is **not required for the P0 architecture**, though it remains a possible future production authorization model.

### 24.2 Provider connection mechanics

The product behavior is clear — connect once, verify with a live local CLI call,
and publish safe availability state — but connector packaging and local
provider/session binding should be designed separately.

### 24.3 Private-agent transcript retention

Decide whether private drafting conversations are:

- ephemeral
- retained for a short period
- permanently available only to the owning user

The shared project conversation should remain the durable collaboration record regardless.

### 24.4 Repository synchronization

Decide when the connector refreshes safe branch/commit metadata and how local worktree selection works. Telaegent cloud does not fetch or modify the repository.

### 24.5 Message attachments / source snippets

The MVP may begin with text-only approved messages. File excerpts and structured attachments can be added only if the trust boundary remains obvious.

### 24.6 Low-risk auto-send in the future

The hackathon should keep explicit human approval for outbound cross-user messages. A later product could allow users to pre-authorize low-risk categories or a bounded conversation window, but this should not complicate the first demo.

This is a separate question from capability scope. Section 8 automates *internal
resource access* inside granted authority; it never automates *sending*. Do not
let one become an argument for the other.

### 24.7 Capability-scope mechanics

The policy is settled in [canonical build plan section 8](canonical-build-plan.md):
automatic access requires same task, same peer, same exact resource, read-only,
an unexpired grant, and safe resolution inside the registered project. What the
implementation plan still has to decide:

- where a task's initial grant comes from: whether the sender attaches files
  when sending, or the first request is always a prompt
- where capability grants live, and how expiry and revocation propagate to a
  connector that was offline when the owner revoked
- whether a resource ID stays stable when the file is renamed or deleted, not
  only when its contents change
- the actual follow-up round, per-round request, and total-byte limits, and how
  the UI explains hitting one
- how a task ends, since task-scoped grants expire with it
- whether the owner gets a running view of what has been auto-served, and how
  they revoke mid-task

---

## 25. Main risks and flaws to watch

### 25.1 The connector is a privileged local boundary

Keeping repositories and provider identities local avoids cloud custody, but the
connector can inspect code and launch powerful local CLIs. It must accept only
bounded signed job types, resolve only its registered workspace/provider, and
never treat cloud or collaborator text as a path, executable, or command.

For the hackathon, use controlled repositories/accounts and be honest that
production requires hardened connector authentication, update, revocation,
local isolation, and job validation.

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

The recipient's own agent performs inspection in that user's registered local workspace and the owner approves the outbound answer.

### 25.7 Provider terms and connector automation need production review

The developer runs the provider CLI locally, but Telaegent still automates
non-interactive turns through a connector. Before production, verify provider
terms, subscription/automation policies, rate limits, and supported local
authentication patterns.

### 25.8 Repo collaborator discovery can be messy

Do not assume `gh repo list` or a repository-collaborator endpoint solves this universally. Repository access can come from ownership, direct collaboration, or organization/team membership, and collaborator enumeration may require privileges an ordinary contributor does not have.

P0 should match Telaegent users by **independent proof that each connected the same GitHub repository ID**, then allow a project-scoped connection request.

### 25.9 Local credentials never cross into cloud custody

Using local GitHub CLI avoids a Telaegent-held GitHub credential. The connector
may call `gh` locally, but it returns only safe identity/repository proof and
never credential files, token-bearing output, or local paths.

### 25.10 Connector authentication and local binding are major gates

The product requires each user's local Claude Code/Codex identity and selected
repository to be bound to the correct opaque connector registration without
leaking local state or accepting arbitrary work.

Before broad implementation, prove:

```text
register connector once
→ outbound reconnect preserves the correct binding
→ new local process still uses the owning identity
→ provider session can resume locally
→ Repo A jobs cannot resolve Repo B paths
→ credentials/session never enter cloud payloads or logs
```

### 25.11 Capability scope is the easiest place to quietly over-grant

Task-scoped grants exist so a collaboration can finish without ten approval
prompts. That convenience is exactly what makes them dangerous: **Allow for
this task** is the one click in the product that turns off future clicks.

The failure modes to watch are a task that never ends, a grant that survives
after the peer stops needing it, an LLM-authored justification that persuades
an owner to grant something broad, and a resource ID that quietly starts
resolving to a different file.

Enforcement must stay outside the model. The local policy engine and file
broker decide; the agent only asks. If the agent's request text is what
determines the answer, the boundary is already gone.

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

1. **Telaegent is cloud-first for coordination and local-first for execution.** A local connector is required; no LAN or peer-to-peer dependency is required.
2. **GitHub repository is the project boundary.**
3. **A collaborator relationship is project-scoped, never global by default.**
4. **Users bring Claude Code, Codex, or both.**
5. **The local connector runs provider CLIs; Telaegent cloud never does.**
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
- [`thai.md`](../team/thai.md) — cloud deployment, connector networking, database/storage, cost and latency
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
- one local connector per user
- project invite/acceptance
- shared conversation
- private draft popup
- CLI invocation
- human approval

The difficult parts are not the messaging UI. They are connector installation
and authentication, safe user × repository binding, reliable outbound job
delivery, and making local CLI execution dependable during a demo.

The hackathon should optimize for one extremely polished vertical slice rather than production-grade infrastructure.

## Security/product-risk rating — **6.5 / 10 today, potentially 9 / 10 with production hardening**

The cloud/local split reduces Telaegent's custody of source code and provider
authorization state, but makes the connector a privileged local component.

For a hackathon this is manageable with controlled demo accounts and
repositories. For a real product, connector authentication, signed/bounded
jobs, local path isolation, update security, access control, logging discipline,
retention, revocation, and provider-policy review become first-class work.

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
