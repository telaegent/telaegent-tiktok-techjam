# Telagent: Canonical Product Flow

## Product definition

**Telagent is a messaging and trust platform for separately owned AI agents.** It lets an Agent on one computer coordinate with an Agent on another computer without sharing raw sessions, credentials, or full workspaces. Agents share structured work intent, request approved context, prevent conflicting work, and adapt when teammates' plans change while humans retain control over disclosure and commitments.

The TikTok TechJam prototype targets two coding Agents, two mock owners, two computers on one private LAN, and one shared logical software project. It extends the Track 1 Starter Kit's React/Fastify control plane while moving Agent execution to one owner-controlled worker per computer.

## Final two-computer topology

```text
Computer A                                                Computer B
┌──────────────────────────────────────┐                  ┌──────────────────────────────┐
│ Browser / React UI                   │                  │ Bob private workspace        │
│          ↓                           │                  │ Bob local Codex/Claude CLI   │
│ Fastify + Telagent + JSON store      │                  │          ↑                   │
│          ↑                           │                  │ Bob Agent Worker             │
│ Alice Agent Worker                   │<──── LAN HTTP ───┴──────────────────────────────┘
│ Alice workspace + local Agent CLI    │   outbound long-poll
└──────────────────────────────────────┘
```

- Computer A hosts the only Fastify server, UI, and coordination store, plus Alice's worker.
- Computer B hosts Bob's worker, workspace, and locally authenticated Agent CLI.
- Workers register, heartbeat, long-poll for authorized jobs, and return structured results.
- P0 uses a manually configured server URL and one long random token per worker. There is no discovery service, broker, WebSocket layer, or cloud dependency.
- ModelArk is removed completely. Telagent does not select or host a model; each worker uses its computer's existing Codex or Claude authentication.
- A dedicated phone hotspot or trusted private LAN is the primary demo network. Plain LAN HTTP is a disclosed prototype limitation and must never be exposed directly to the public internet.

## Non-negotiable core flow

> Publish intent -> detect conflict -> exchange structured status -> propose a resolution -> obtain separate human approvals -> transfer a permissioned, source-backed ContextPack -> detect dependency changes -> adapt affected plans -> complete with an auditable history.

This flow is the project's authoritative product direction. Scope should be reduced through controlled fixtures and limited scenarios, not by removing its defining stages.

## Positioning

Telagent is a collaboration and trust layer for employee-owned coding agents. Different people own different agents. Those agents can collaborate without exposing private memory or committing their owners to consequential decisions without permission.

The hackathon demonstration focuses on a small software team because conflicts, dependencies, code changes, and project knowledge are visible and measurable. The middleware primitives could later apply to research, operations, and other workplace agents.

Telagent is not:

- A generic human chat app
- A replacement for the Starter Kit
- An autonomous code-merging system
- A generic resource-locking service or task queue
- A system that reads hidden reasoning or complete private transcripts
- A claim of complete A2A protocol compliance

## Starter Kit integration

Keep and extend the Starter Kit's React UI, Fastify control plane, Agent CRUD concepts, lifecycle conventions, runner interface, workspaces, and JSON persistence. Remove all ModelArk-specific configuration and assumptions. The server-side `AgentService` lifecycle becomes a reusable local worker service rather than the only place Agents can execute.

Telagent is inserted between Fastify and owner-controlled Agent Workers:

```text
Existing React UI
        |
Existing Fastify API
        |
Telagent Middleware
  |- Intent and conflict engine
  |- Coordination requests
  |- Structured status exchange
  |- Resolution proposals
  |- Human approvals
  |- ContextPack policy and validation
  |- Dependency impact and replanning
  `- Audit events
        |
Persisted worker-job queue
        |
Private LAN HTTP: register / heartbeat / long-poll / complete
        |
Owner's Agent Worker
        |
Local AgentService -> local AgentRunner -> local workspace
```

Use the existing JSON store for the prototype. Do not introduce AWS, DynamoDB, S3, a separate FastAPI service, ECS, or a hosted inference service.

## Controlled project setup

Create one seeded project:

```text
Project: Phoenix
Repository fixture: Phoenix Web App
```

Create two separately owned Agents:

```text
Owner: Alice
Agent: Alice Coding Agent
Workspace or branch: phoenix-alice / feature/google-oauth
```

```text
Owner: Bob
Agent: Bob Coding Agent
Workspace or branch: phoenix-bob / feature/redis-sessions
```

Both Agent workspaces contain copies or separate branches of the same seeded project identity, but Alice's files stay on Computer A and Bob's files stay on Computer B. Add a lightweight `projectId`, mock owner identity, worker binding, and expected fixture revision to associate them. Production authentication is explicitly out of scope.

## Sharing policy

Automatically shareable:

- Current task
- Work state and progress
- Branch name
- Planned and changed files
- Declared interfaces and dependencies
- Approved project documentation

Requires owner approval:

- Code excerpts
- Design notes
- Generated ContextPacks
- Architectural decisions or consequential work agreements

Always forbidden:

- `.env` files
- Credentials, API keys, and tokens
- Files outside the connected project workspace
- Private conversations
- Complete Agent transcripts
- Hidden chain-of-thought or private reasoning

## End-to-end scenario

### 1. Bob publishes an active work intention

Bob asks his Agent to migrate session storage to Redis. Before or alongside implementation, Bob's Agent produces:

```json
{
  "task": "Migrate session storage to Redis",
  "plannedFiles": [
    "src/auth/session.ts",
    "src/models/session.ts"
  ],
  "interfaces": ["Session"],
  "dependencies": ["User"],
  "branch": "feature/redis-sessions"
}
```

Telagent validates and persists the intention. Bob's Agent performs a real Codex Run, makes an initial change, and publishes a checkpoint:

```json
{
  "state": "in_progress",
  "progress": 60,
  "changedFiles": [
    "src/auth/session.ts",
    "src/models/session.ts"
  ],
  "interfaces": ["Session"],
  "blockers": [],
  "lastVerifiedAt": "..."
}
```

The Runtime invocation may finish while the larger task remains `in_progress`, leaving Bob's private local Agent session available on Computer B for bounded status and context requests.

### 2. Alice submits a potentially conflicting task

Alice asks her Agent to add Google OAuth login. Telagent first asks Alice's Agent for a planning-stage structured intention before implementation continues:

```json
{
  "task": "Add Google OAuth",
  "plannedFiles": [
    "src/auth/oauth.ts",
    "src/routes/login.ts"
  ],
  "interfaces": [
    "Session",
    "POST /login",
    "GET /oauth/callback"
  ],
  "dependencies": ["User", "Session"],
  "branch": "feature/google-oauth"
}
```

At this point Alice's Agent has not made the potentially conflicting implementation change.

### 3. Telagent deterministically detects the conflict

Telagent compares active intentions in the same project. A suggested deterministic scoring model is:

| Signal | Score |
| --- | ---: |
| Same currently modified file | +5 |
| Planned file overlaps a modified file | +4 |
| Same interface, API, or schema | +4 |
| Same planned file | +3 |
| Same module or directory | +1 |
| Different base commits | +1 |

Interpretation:

- `0-2`: no warning
- `3-4`: coordination suggested
- `5+`: likely conflict; acknowledgment required

Alice and Bob both depend on or modify the `Session` interface, so Telagent opens a coordination request. The model may explain the detected conflict and suggest options, but deterministic rules decide whether the conflict exists.

### 4. Telagent requests bounded status from Bob's Agent

Telagent asks Bob's existing Agent session for only current structured status:

```json
{
  "task": "Migrate session storage to Redis",
  "state": "in_progress",
  "branch": "feature/redis-sessions",
  "changedFiles": [
    "src/auth/session.ts",
    "src/models/session.ts"
  ],
  "interfaces": ["Session"],
  "progress": 60,
  "blockers": [],
  "lastVerifiedAt": "..."
}
```

The response does not contain Bob's private transcript or hidden reasoning. If Bob's Agent is unavailable, Telagent returns the latest checkpoint with a visible `stale` label.

### 5. Telagent proposes a compatible division of work

Using the structured intentions and verified status, Telagent proposes options. The canonical demonstration agreement is:

```text
Bob owns:
- Session interface
- Redis persistence
- SessionRepository implementation

Alice owns:
- OAuth routes
- OAuth callback handling
- Provider integration

Agreement:
- Alice may work against the current Session contract.
- Bob must publish any Session contract change.
- Telagent will notify and replan Alice's dependent work when it changes.
```

The model proposes; it does not approve or silently choose an architectural direction.

### 6. Both owners approve separately

The Coordination view shows separate controls for Alice and Bob. Telagent activates the agreement only after both approve and records the humans, Agents, scope, decision, and timestamp.

If either owner rejects the proposal, it is not activated. Telagent requests a revision or escalates instead of allowing indefinite Agent negotiation.

### 7. Alice's Agent resumes constrained implementation

Telagent resumes Alice's persistent session with:

- Her original task and plan
- Bob's verified status
- The approved ownership agreement
- Files and interfaces she may own
- A dependency link to Bob's `Session` contract

Alice's Agent performs a real implementation Run, such as creating:

```text
src/auth/oauth.ts
src/routes/oauth-callback.ts
tests/oauth.test.ts
```

It avoids redefining the `Session` interface or taking ownership of Redis persistence.

### 8. Alice's Agent requests permissioned project context

During implementation, Alice's Agent requests:

```text
Ask Bob's Agent why this project uses Redis sessions and how authenticated routes should interact with them.
```

Telagent creates a bounded request:

```json
{
  "type": "context_request",
  "sender": "alice-agent",
  "recipient": "bob-agent",
  "topic": "Redis session architecture",
  "purpose": "Implement Google OAuth",
  "requestedSources": [
    "architecture documentation",
    "authentication code",
    "project conventions"
  ],
  "persistence": "current-task-only"
}
```

### 9. Telagent applies context-sharing policy

Telagent verifies:

1. Both Agents belong to the same project.
2. The request declares a purpose.
3. The requested source categories are shareable.
4. No forbidden path is requested.
5. Required owner approval has been obtained.
6. The request has not expired.

For the valid scenario, Bob approves access to controlled paths such as:

```text
docs/architecture/**
src/auth/**
tests/auth/**
```

A request for `.env`, credentials, or files outside the project is denied.

### 10. Bob's Agent creates a source-backed ContextPack

Bob's Agent inspects only approved sources and returns a bounded artifact:

```json
{
  "artifactType": "context_pack",
  "topic": "Redis session architecture",
  "summary": "Refresh sessions are stored through SessionRepository...",
  "implementationSteps": [
    "Use the existing SessionRepository",
    "Apply the configured session expiry",
    "Do not access Redis directly from route handlers"
  ],
  "validationChecklist": [
    "Refresh token expiry matches the Redis entry",
    "Logout removes the session key",
    "Tests use the fake SessionRepository"
  ],
  "sources": [
    {
      "path": "docs/architecture/auth.md",
      "commit": "af31d4e"
    },
    {
      "path": "src/auth/session-repository.ts",
      "commit": "af31d4e"
    }
  ],
  "sharedBy": "bob-agent",
  "scope": "task:google-oauth",
  "expiresAt": "..."
}
```

The ContextPack is not Bob's complete memory or transcript. It is a permissioned, purpose-specific artifact.

### 11. Telagent validates and delivers the ContextPack

Before delivery, Telagent deterministically ensures:

- All sources are within approved directories.
- At least one source is included.
- Forbidden paths are rejected.
- Secret-like patterns are blocked or redacted.
- Artifact size is bounded.
- Source paths and commit hashes are attached.
- Project, task scope, and expiry remain valid.

Invalid artifacts are rejected and recorded. Valid ContextPacks are injected into Alice's current task only, not permanent Agent memory.

### 12. Bob changes a shared dependency

Bob's Agent reports a contract change:

```json
{
  "event": "interface_changed",
  "interface": "Session",
  "change": "SessionRepository.create now requires deviceId",
  "source": "src/auth/session-repository.ts",
  "commit": "bf4812c"
}
```

Telagent matches the changed interface against active intentions and agreements. It identifies Alice's OAuth task as affected.

### 13. Telagent triggers adaptive replanning

Telagent sends Alice's Agent:

- The changed contract
- The source reference
- The active agreement
- A bounded request to revise the plan

Alice's Agent returns an explicit plan delta:

```json
{
  "originalPlan": [
    "Create a session after the OAuth callback"
  ],
  "revisedPlan": [
    "Extract deviceId from the validated request context",
    "Pass deviceId to SessionRepository.create",
    "Update OAuth callback tests"
  ],
  "affectedFiles": [
    "src/routes/oauth-callback.ts",
    "tests/oauth.test.ts"
  ]
}
```

The UI shows the original and revised plans. Alice acknowledges or approves the revision, and her Agent resumes implementation.

This is the central agentic loop:

> Plan -> act -> observe another Agent's change -> coordinate -> adapt -> continue.

### 14. Completion and durable evidence

Alice's Agent runs tests and completes the task. Telagent closes the intention, coordination request, agreement, temporary ContextPack, and dependency-impact event while retaining an attributable audit history.

The visible timeline should contain:

```text
Bob published work intent
Alice published work intent
Conflict detected
Bob returned structured status
Resolution proposed
Alice approved
Bob approved
Alice implementation started
Context requested
Context approved
ContextPack validated and delivered
Forbidden context request denied
Bob changed Session contract
Alice's plan revised
Alice's implementation completed
```

## Failure and degraded cases

The implementation and live demo must include appropriate failure evidence.

### Forbidden context request

Alice requests Bob's `.env`. Telagent denies the request before disclosure and records the protected path, rule, actor, and result without storing secret contents.

### Invalid ContextPack

Bob's Agent returns an artifact without sources or containing an unapproved path. Telagent rejects delivery and records why.

### Offline or stale Agent

Telagent displays Bob's latest checkpoint as stale, disables automatic consequential agreement, and asks for human handling.

### Rejected agreement

Either owner rejects the proposal. The agreement never becomes active, and Telagent requests revision or escalation.

### Bounded coordination

After three Agent-to-Agent exchanges, a timeout, or one unresolved clarification, Telagent pauses the request and escalates to a person.

## Minimal UI additions

Preserve the existing Playground and add only the UI needed to expose middleware evidence.

### Team Activity

- Agent and mock owner
- Current task and branch
- Planned and changed files
- Interfaces and dependencies
- Progress and freshness
- Conflict warnings

### Coordination

- Conflicting intentions
- Structured status
- Conflict explanation
- Proposed ownership agreement
- Separate Alice and Bob approvals
- Dependency updates
- Original and revised plans

### ContextPack

- Topic and purpose
- Requested source categories
- Policy and approval decision
- Delivered artifact and citations
- Scope and expiry
- Denial, validation, or redaction evidence

## Prototype data model

```text
Projects
- projectId
- name
- agentIds

Owners
- ownerId
- displayName

Intents
- intentId
- agentId
- task
- branch
- plannedFiles
- changedFiles
- interfaces
- dependencies
- status
- updatedAt

CoordinationRequests
- requestId
- threadId
- type
- senderAgent
- recipientAgent
- projectId
- purpose
- requestedScope
- state
- createdAt
- expiresAt

Agreements
- agreementId
- participants
- proposal
- approvals
- state
- updatedAt

ContextPacks
- artifactId
- requestId
- content
- sources
- scope
- expiresAt

Events
- eventId
- requestId
- actor
- eventType
- payload
- timestamp
```

## Logical Telagent operations

Preserve these six operations, whether implemented through internal Agent Runs, a thin adapter, CLI, or MCP integration:

```text
relay_publish_intent
relay_update_progress
relay_ask_status
relay_request_context
relay_reply
relay_complete_task
```

These logical operations remain product-level messages. They are delivered through persisted worker jobs:

```text
Alice action
  -> Fastify validates and creates an Operation
  -> Telagent queues a typed job for Bob's bound worker
  -> Bob's worker leases it over the LAN
  -> Bob's local AgentService/runner invokes Bob's local CLI in Bob's workspace
  -> Bob's worker returns one structured candidate
  -> Fastify revalidates schema, policy, version, and correlation ID
  -> Telagent stores only the safe result and exposes it to Alice
```

P0 worker endpoints under `/api/telagent`:

```text
POST /workers/register
POST /workers/:workerId/heartbeat
GET  /workers/:workerId/jobs/next?waitMs=25000
POST /jobs/:jobId/complete
POST /jobs/:jobId/fail
```

Every worker token binds to exactly one Agent ID. Jobs use leases, expiry, idempotency, bounded payloads, safe typed failures, and one terminal completion. A job specifies a purpose and execution policy, never an arbitrary command or sender-selected local path. The worker resolves its own configured workspace. Raw provider streams, credentials, provider homes, and private sessions never cross the LAN.

Approved-source ContextPack isolation runs on the source owner's computer. Bob's worker copies only approved files into a temporary local workspace, creates a trusted manifest, runs an ephemeral read-only Agent turn, validates the candidate, and returns only the bounded artifact. Alice never receives Bob's full workspace.

## Hackathon scope limits

- Two Agents
- Two mock owners
- One seeded project
- One conflict scenario
- One agreement requiring both approvals
- One valid ContextPack
- One forbidden request
- One dependency change and adaptive replan
- Three exchanges maximum per coordination request
- Allowlisted local project files only
- No automatic code merging
- No production authentication
- Exactly two manually configured LAN workers; no discovery, NAT traversal, or public federation
- No ModelArk, hosted inference service, self-hosted model weights, or GPU hosting
- No message broker, second database, or network-shared workspace
- No claim of full A2A compliance
- Local Agent execution on each owner's computer is mandatory

## Essential automated verification

- Overlapping interfaces create a conflict.
- Unrelated intentions do not create a false conflict.
- LLM output cannot override the deterministic conflict result.
- Both owners must approve an agreement.
- Rejected agreements never activate.
- Forbidden paths cannot enter a ContextPack.
- Secret-like content is blocked or redacted.
- ContextPacks require valid, approved sources.
- Stale status is clearly identified.
- Dependency changes identify affected intentions.
- Replanning preserves the approved ownership agreement.
- Exchange and timeout limits trigger escalation.
- Worker tokens cannot lease or complete another Agent's jobs.
- Worker heartbeat, lease expiry, duplicate completion, reconnect, and offline behavior are deterministic.
- Two fake workers can execute the full canonical flow through Fastify.
- Existing Agent CRUD, Playground, persistence, and Runtime execution continue to work.
- `npm run check` passes.

## Three-minute demo narrative

Alice and Bob use separate coding Agents on two computers connected through a private LAN. Their Agents unknowingly depend on the same `Session` interface. Telagent detects the conflict before incompatible work is completed, dispatches a bounded status request to Bob's local worker, proposes a human-approved division of responsibility, lets Alice continue a real local coding Run, safely transfers a source-backed ContextPack rather than Bob's workspace, blocks an attempt to access `.env`, and revises Alice's plan when Bob changes the shared contract.

The closing message is:

> Telagent does not replace human teamwork. It lets separately owned agents coordinate routine details while people retain ownership, privacy, and authority.
