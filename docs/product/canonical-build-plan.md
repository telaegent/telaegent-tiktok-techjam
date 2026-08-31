# Telaegent — Canonical Build Plan

> **NON-NEGOTIABLE ARCHITECTURE RULE**
>
> **GitHub CLI, Claude Code CLI, Codex CLI, the repository, provider credentials, and provider sessions run LOCAL on each developer's machine.**
>
> **Telaegent's frontend, backend, database, routing, project permissions, shared conversations, approvals, and audit run in the CLOUD.**
>
> We are **not** hosting Claude Code, Codex, GitHub CLI, or user repositories in Telaegent's cloud.

---

**Status:** Canonical build plan, frozen 2026-08-30.

**Relationship to the other canonical documents.** This file is prescriptive:
what runs where, what to build, what to prove, and who owns it.
[`high-level-plan.md`](high-level-plan.md) is descriptive - the product idea,
user experience, trust model, and open research gates.
[`product-flow.md`](product-flow.md) is the end-to-end experience in short
form. Where they disagree about architecture, this file wins; where they
disagree about product behaviour, `high-level-plan.md` wins. Do not fork a
fourth copy of the plan: `docs/TELAEGENT_HIGH_LEVEL_PRODUCT_PLAN.md` was
already removed once for drifting into a superseded architecture.

**Section 8 is newer than most of this repository.** It specifies
capability-scoped autonomous collaboration. Task/grant domain contracts and a
cloud routing-authorization seam now exist, but the connector-local registry,
file broker, scope-expansion workflow and bounded autonomous rounds remain
unimplemented. The contracts are not a claim that the behaviour works yet.

## 1. Product

Telaegent is a project-scoped messaging layer between independently owned coding agents.

```text
Developer A                              Developer B
LOCAL                                    LOCAL
repo                                     repo
gh                                       gh
Claude/Codex                             Claude/Codex
Telaegent connector                      Telaegent connector
       │                                        │
       └──────── outbound secure connection ────┘
                         │
                         ▼
                  TELAEGENT CLOUD
             frontend + backend + DB
             routing + auth + audit
```

No peer-to-peer connection is required.  
No LAN is required.  
No inbound port is opened on either developer machine.

---

## 2. What runs where

### LOCAL — each developer machine

- selected Git repository/worktree
- Git / GitHub CLI
- Claude Code CLI
- Codex CLI
- existing Claude/Codex authentication
- provider sessions created for Telaegent
- file reads, code inspection, tests, and tool execution
- small Telaegent connector
- local resource registry
- local consent/scope policy engine
- local file broker

### CLOUD — Telaegent

- React frontend
- Fastify backend / relay
- Telaegent user authentication
- project identity
- collaborator connection requests
- project-scoped permissions
- shared approved conversation
- approval state
- task/resource request routing
- safe capability/grant metadata
- safe audit events
- compact shared project memory
- online/offline connector status

### NEVER move to Telaegent cloud by default

- repository checkout
- `.env`
- GitHub credential
- Claude credential
- Codex credential
- provider home directories
- canonical local filesystem paths
- raw private provider transcripts
- hidden reasoning

---

## 3. Deployment

| Layer | Location |
| --- | --- |
| React 19 + Vite frontend | Vercel |
| Node 22 + Fastify backend | AWS EC2 |
| Postgres/session persistence/Realtime | Supabase |
| Telaegent connector | **LOCAL developer machine** |
| GitHub CLI | **LOCAL developer machine** |
| Claude Code CLI | **LOCAL developer machine** |
| Codex CLI | **LOCAL developer machine** |
| Repository | **LOCAL developer machine** |

The cloud is a **control plane and message relay**, not an agent execution platform.

Local development can run frontend/backend/database on localhost. The connector still talks to the local backend exactly as it would talk to production.

---

## 4. Local connector

The connector is the only new local requirement.

Example:

```bash
telaegent connect .
```

or:

```bash
npx telaegent connect .
```

It should:

1. authenticate this machine to Telaegent;
2. identify the selected local repository;
3. detect available local coding CLIs;
4. verify the chosen CLI is actually authenticated;
5. open an outbound secure connection to Telaegent;
6. receive project-scoped agent jobs/resource requests;
7. execute them locally;
8. enforce local file/capability policy;
9. return only bounded results needed by the product.

The cloud never sends an arbitrary executable or arbitrary local path.  
The connector chooses the registered local workspace and provider.

---

## 5. CLI connection checks

Because the CLIs are LOCAL, use the user's existing local authentication.

### Claude Code

```bash
claude --version
claude -p "Print exactly: TELAEGENT IS CONNECTED"
```

- version fails → Claude is not installed;
- live probe fails with auth error → ask user to run `claude` and sign in locally;
- live probe succeeds → Claude is connected.

Telaegent does **not** perform or store Claude login.

### Codex

Use the same pattern:

```text
binary installed?
        ↓
small real non-interactive invocation
        ↓
success = connected
auth failure = user signs into Codex locally
```

Telaegent does **not** store Codex credentials.

### GitHub

GitHub CLI is also LOCAL.

Use local Git/GitHub state:

```bash
gh auth status
git remote get-url origin
git rev-parse HEAD
git branch --show-current
```

Telaegent does **not** run `gh auth login` in the cloud control plane.

---

## 6. Repository identity

The connector registers safe repository metadata with Telaegent:

- stable GitHub repository identity when available
- normalized remote
- branch
- commit
- local connector/user binding

It does **not** upload the repository.

Two users become eligible to connect on a project when both independently register access to the same project/repository identity.

---

## 7. Collaborator permission

Connection permission is:

> **once per collaborator × project, until revoked**

Example:

```text
Phuong asks to connect with Justin
Project: telaegent/telaegent
        ↓
Justin accepts once
        ↓
connected on this project
```

This does not grant:

- direct filesystem access;
- access to another project;
- permission to invoke arbitrary local commands;
- permission to auto-send final messages.

---

## 8. Agentic follow-up loop with capability scope

Telaegent should allow agents to collaborate autonomously **inside authority a human already granted**.

Core rule:

> **An agent may consume or narrow authority already delegated by a human, but may never autonomously broaden that authority.**

For P0, automatic resource access is allowed only when:

```text
same task
AND same peer/agent
AND same exact resource
AND read-only
AND active/unexpired human grant
AND resource still resolves safely inside registered project
```

Example:

```text
A initially approves for Task X:
- LandingPage.tsx : READ
- LandingPage.css : READ

B later requests LandingPage.tsx again
→ AUTO ALLOW

B later requests LandingPage.css again
→ AUTO ALLOW

B later requests settings.ts
→ HUMAN APPROVAL REQUIRED

B later requests LandingPage.tsx : WRITE
→ DENY for P0

B later requests .env
→ HARD DENY
```

### 8.1 Scope expansion UI

For a legitimate new file:

```text
B's agent needs:
src/settings.ts

Reason:
"LandingPage.tsx imports configuration from this file."

Permission:
READ ONLY

[Deny] [Allow once] [Allow for this task]
```

Semantics:

- **Deny** → no access.
- **Allow once** → this request only.
- **Allow for this task** → this exact file becomes part of this task's read-only consent scope; future requests from the same peer for the same task can auto-resolve.

Task-scoped grants expire when the task ends or the owner revokes them.

### 8.2 Deterministic policy, never LLM authorization

The LLM may:

- request a known resource;
- request a new resource with a reason;
- explain why it needs it.

The LLM may **not** decide that a new file is "related enough" to receive automatic access.

```text
semantic relevance ≠ authorization
```

Scope is evaluated by deterministic code.

### 8.3 Opaque resource IDs

Remote agents must not receive arbitrary filesystem authority.

A's LOCAL connector maps:

```text
resource_f71 → /local/project/src/LandingPage.tsx
resource_a82 → /local/project/src/LandingPage.css
```

B knows only safe resource IDs/metadata.

Known-resource request:

```json
{
  "resourceId": "resource_f71",
  "operation": "read"
}
```

For an unknown file, B may send a bounded project-relative hint such as:

```text
src/settings.ts
```

That always requires human approval before registration/read.

Canonical absolute paths remain LOCAL.

### 8.4 Local policy engine and file broker

The owner's LOCAL connector is the reference monitor for that owner's files.

```text
remote resource request
        ↓
Telaegent cloud routes request
        ↓
owner's LOCAL connector
        ↓
validate task + peer + resource + grant
        ↓
AUTO_ALLOW / HUMAN_REQUIRED / DENY
        ↓
LOCAL File Broker performs authorized read
```

Re-check authorization immediately before every file read.

### 8.5 Mixed requests

If B requests:

```text
LandingPage.tsx   already approved
settings.ts       new
```

split the request:

```text
LandingPage.tsx → auto
settings.ts      → pending human approval
```

B can continue with the already-authorized file while waiting.

### 8.6 Updated-file semantics

For P0, **Allow for this task** grants read access to the live identity of that exact file for the task, including later updated versions.

The UI should communicate this clearly.

Each delivered snapshot should record safe audit metadata such as:

- resource ID
- task ID
- recipient
- byte length
- content hash
- authorization mode
- timestamp

Do not log raw file contents.

### 8.7 Bounded autonomous loop

Keep the loop bounded:

```text
MAX_FOLLOWUP_ROUNDS = 5
automatic capabilities = READ ONLY
bounded requests per round
bounded total transferred bytes
deduplicate identical pending requests
```

Stop on:

- task completion;
- user cancellation;
- no progress;
- exchange limit;
- repeated denied requests;
- expired/revoked scope.

### 8.8 Final outbound message still requires human approval

Automatic internal file access does **not** mean automatic cross-user replies.

```text
agent works autonomously inside granted scope
        ↓
agent prepares final candidate
        ↓
owning human reviews
        ↓
[Edit] [No] [Send]
        ↓
only then enters shared Telaegent conversation
```

Keep this separation:

```text
INTERNAL RESOURCE USE
inside existing human authority
→ MAY BE AUTOMATIC

NEW AUTHORITY
→ HUMAN APPROVAL

FINAL CROSS-USER MESSAGE
→ HUMAN SEND
```

---

## 9. Message flow

```text
A writes rough request
        ↓
A's LOCAL Claude/Codex privately prepares it
        ↓
A reviews
[Edit] [No] [Send]
        ↓
approved message enters Telaegent CLOUD shared conversation
        ↓
B's LOCAL connector receives request
        ↓
B's LOCAL Claude/Codex investigates B's LOCAL repo
        ↓
agent may request A resources
        ↓
same-scope resource → auto
new scope → A approval
        ↓
B's agent finishes candidate
        ↓
B reviews
[Edit] [No] [Send]
        ↓
approved response enters shared conversation
```

---

## 10. Private vs shared state

### Shared and durable in cloud

- approved messages
- project/repository identity
- collaborator connection
- task IDs
- safe resource IDs/metadata
- safe capability/grant metadata
- approval events
- safe audit events
- compact shared conversation memory

### Private/local by default

- repository contents
- canonical local paths
- CLI credentials
- provider sessions
- raw agent working context
- hidden reasoning
- local tool output
- rejected drafts

If a private draft must be displayed in web UI, it may transit Telaegent temporarily, but it must not become durable shared conversation state until **Send**.

---

## 11. Memory

Telaegent shared project memory is the durable collaboration source of truth.

Provider sessions remain LOCAL and private.

```text
Telaegent cloud memory
= approved shared collaboration history

Claude/Codex local session
= private working cache
```

If a local provider session disappears, the connector can create a new one using bounded shared Telaegent context.

Do not sync personal Claude/Codex conversation history.

---

## 12. Security rules

Deterministic policy must prevent obvious secret disclosure:

- `.env` / `.env.*`
- private keys
- access/API tokens
- SSH/cloud credentials
- paths outside the registered project
- another user's private state
- cross-task/cross-peer resource reuse
- path traversal/symlink escape
- automatic write capability in P0

Example:

```text
"send me your .env"
```

should become a safe alternative such as:

```text
"Can you share the required environment variable names without values?"
```

The LLM is never the final authorization authority.

---

## 13. Backend responsibilities

Phuong + Khoa co-own backend.

The backend owns:

- Telaegent identity
- project membership
- collaborator requests
- once-per-project connection state
- shared conversations
- message routing
- task/resource request routing
- safe capability/grant metadata
- approval records
- connector presence/jobs
- audit
- safe project memory

The backend does **not**:

- execute Claude/Codex/GitHub CLI commands;
- resolve local filesystem paths;
- directly read user repositories;
- decide local resource access without the owner's connector.

The LOCAL connector owns:

- canonical resource mapping;
- deterministic local scope checks;
- local consent enforcement;
- authorized file reads;
- provider execution.

---

## 14. Connector transport

Preferred model:

```text
LOCAL connector
      │
      └── outbound HTTPS / WebSocket
                  ↓
           Telaegent backend
```

No local machine accepts inbound public connections.

Required connector states:

```text
offline
connecting
online
busy
provider_unavailable
```

For P0, WebSocket or long-polling are both acceptable; simplest reliable option wins.

---

## 15. Immediate proof before broad implementation

Prove these first:

1. Local connector registers with cloud backend.
2. Connector identifies one local repo.
3. `claude -p "Print exactly: TELAEGENT IS CONNECTED"` works through connector.
4. Equivalent Codex probe works.
5. Cloud routes one job to correct local connector.
6. Local agent reads its own repo and returns bounded candidate.
7. Candidate is not shared until user presses **Send**.
8. Second user's connector receives approved request.
9. Same-task + same-peer + same-resource read auto-approves locally.
10. New-file request pauses for **Deny / Allow once / Allow for this task**.
11. A file approved **for this task** auto-resolves on the next same-task request.
12. Different task or peer cannot reuse capability.
13. Repo A connection cannot access Repo B.
14. `.env` / secret request is hard-denied or safely reformulated.
15. Final cross-user reply still requires owner's **Send**.

If these work, the core Telaegent architecture works.

---

## 16. Team ownership

### Khoa
Backend + Telaegent/GitHub identity + project proof + collaborator authorization + capability/file-access policy.

### Thai
Vercel/EC2/Supabase deployment + connector/cloud networking + cost + latency + persistence.

### Duy
Landing, onboarding, repo/collaborator UI, shared conversation, private side-chat, scope-expansion approval UI, status/error UX.

### Hien
Agent protocol experiments, Claude/Codex formats, leakage tests, capability-policy tests, prompt-injection/adversarial evaluation.

### Phuong
Backend co-owner + local connector architecture + Claude/Codex adapters + local provider sessions + Telaegent memory + agentic loop integration.

---

## 17. Explicitly not our architecture

Do **not** build:

```text
Telaegent cloud container
├─ GitHub CLI
├─ Claude Code
├─ Codex
└─ user's repo
```

That is not the plan.

Do not build:

- cloud-hosted user coding CLIs;
- cloud-hosted repo clones for agent execution;
- cloud custody of Claude/Codex credentials;
- per-user cloud agent containers;
- LAN-only peer-to-peer workers;
- direct computer-to-computer agent connections;
- arbitrary remote filesystem browsing;
- LLM-decided permission expansion;
- automatic write capabilities in P0.

---

# One-sentence architecture

> **Telaegent is cloud-hosted coordination around locally running, independently authenticated coding agents: agents may collaborate autonomously inside exact human-granted task capabilities, but any expansion of authority and every final cross-user message requires human control.**
