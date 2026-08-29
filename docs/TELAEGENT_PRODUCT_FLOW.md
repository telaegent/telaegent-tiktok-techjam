# Telaegent: Canonical Product Flow

## Product definition

**Telaegent is coordination and trust middleware for separately owned AI agents.** It lets agents share structured work intent, request approved context, prevent conflicting work, and adapt when teammates' plans change while humans retain control over disclosure and commitments.

The TikTok TechJam prototype targets two coding agents, two mock owners, and one shared software project. It is implemented as Track 1 middleware inside the provided Agent Launchpad Starter Kit rather than as a replacement platform.

## Non-negotiable core flow

> Publish intent -> detect conflict -> exchange structured status -> propose a resolution -> obtain separate human approvals -> transfer a permissioned, source-backed ContextPack -> detect dependency changes -> adapt affected plans -> complete with an auditable history.

This flow is the project's authoritative product direction. Scope should be reduced through controlled fixtures and limited scenarios, not by removing its defining stages.

## Positioning

Telaegent is a collaboration and trust layer for employee-owned coding agents. Different people own different agents. Those agents can collaborate without exposing private memory or committing their owners to consequential decisions without permission.

The hackathon demonstration focuses on a small software team because conflicts, dependencies, code changes, and project knowledge are visible and measurable. The middleware primitives could later apply to research, operations, and other workplace agents.

Telaegent is not:

- A general messaging or chat platform
- A replacement for the Starter Kit
- An autonomous code-merging system
- A generic resource-locking service or task queue
- A system that reads hidden reasoning or complete private transcripts
- A claim of complete A2A protocol compliance

## Starter Kit integration

The existing Starter Kit continues to own:

- React Agent UI and Playground
- Agent CRUD and lifecycle controls
- Fastify control plane
- `AgentService`
- `AgentRunner`
- Persistent Codex sessions
- Per-Agent workspaces
- Local disposable Runtime containers
- BytePlus ModelArk integration
- Existing JSON persistence

Telaegent is inserted as middleware between the API/control plane and Agent execution path:

```text
Existing React UI
        |
Existing Fastify API
        |
Telaegent Middleware
  |- Intent and conflict engine
  |- Coordination requests
  |- Structured status exchange
  |- Resolution proposals
  |- Human approvals
  |- ContextPack policy and validation
  |- Dependency impact and replanning
  `- Audit events
        |
Existing AgentService
        |
Existing AgentRunner
        |
Codex Runtime and per-Agent workspaces
```

Use the existing JSON store for the prototype. Do not introduce AWS, DynamoDB, S3, a separate FastAPI service, or ECS unless later evidence makes one essential.

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

Both Agent workspaces contain copies or separate branches of the same seeded project. Add a lightweight `projectId` and mock owner identity to associate them. Production authentication is explicitly out of scope.

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

Telaegent validates and persists the intention. Bob's Agent performs a real Codex Run, makes an initial change, and publishes a checkpoint:

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

The Runtime invocation may finish while the larger task remains `in_progress`, leaving Bob's persistent Codex session available for bounded status and context requests.

### 2. Alice submits a potentially conflicting task

Alice asks her Agent to add Google OAuth login. Telaegent first asks Alice's Agent for a planning-stage structured intention before implementation continues:

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

### 3. Telaegent deterministically detects the conflict

Telaegent compares active intentions in the same project. A suggested deterministic scoring model is:

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

Alice and Bob both depend on or modify the `Session` interface, so Telaegent opens a coordination request. The model may explain the detected conflict and suggest options, but deterministic rules decide whether the conflict exists.

### 4. Telaegent requests bounded status from Bob's Agent

Telaegent asks Bob's existing Agent session for only current structured status:

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

The response does not contain Bob's private transcript or hidden reasoning. If Bob's Agent is unavailable, Telaegent returns the latest checkpoint with a visible `stale` label.

### 5. Telaegent proposes a compatible division of work

Using the structured intentions and verified status, Telaegent proposes options. The canonical demonstration agreement is:

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
- Telaegent will notify and replan Alice's dependent work when it changes.
```

The model proposes; it does not approve or silently choose an architectural direction.

### 6. Both owners approve separately

The Coordination view shows separate controls for Alice and Bob. Telaegent activates the agreement only after both approve and records the humans, Agents, scope, decision, and timestamp.

If either owner rejects the proposal, it is not activated. Telaegent requests a revision or escalates instead of allowing indefinite Agent negotiation.

### 7. Alice's Agent resumes constrained implementation

Telaegent resumes Alice's persistent session with:

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

Telaegent creates a bounded request:

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

### 9. Telaegent applies context-sharing policy

Telaegent verifies:

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

### 11. Telaegent validates and delivers the ContextPack

Before delivery, Telaegent deterministically ensures:

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

Telaegent matches the changed interface against active intentions and agreements. It identifies Alice's OAuth task as affected.

### 13. Telaegent triggers adaptive replanning

Telaegent sends Alice's Agent:

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

Alice's Agent runs tests and completes the task. Telaegent closes the intention, coordination request, agreement, temporary ContextPack, and dependency-impact event while retaining an attributable audit history.

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

Alice requests Bob's `.env`. Telaegent denies the request before disclosure and records the protected path, rule, actor, and result without storing secret contents.

### Invalid ContextPack

Bob's Agent returns an artifact without sources or containing an unapproved path. Telaegent rejects delivery and records why.

### Offline or stale Agent

Telaegent displays Bob's latest checkpoint as stale, disables automatic consequential agreement, and asks for human handling.

### Rejected agreement

Either owner rejects the proposal. The agreement never becomes active, and Telaegent requests revision or escalation.

### Bounded coordination

After three Agent-to-Agent exchanges, a timeout, or one unresolved clarification, Telaegent pauses the request and escalates to a person.

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

## Logical Telaegent operations

Preserve these six operations, whether implemented through internal Agent Runs, a thin adapter, CLI, or MCP integration:

```text
relay_publish_intent
relay_update_progress
relay_ask_status
relay_request_context
relay_reply
relay_complete_task
```

For the Starter Kit, prefer using `AgentService`, persistent Codex sessions, and `AgentRunner` rather than building external per-machine sidecars. This is an infrastructure substitution, not a product-flow change.

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
- No cross-machine or cross-vendor integration
- No claim of full A2A compliance
- Local execution is the default

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
- Existing Agent CRUD, Playground, persistence, and Runtime execution continue to work.
- `npm run check` passes.

## Three-minute demo narrative

Alice and Bob use separate coding Agents on the same project. Their Agents unknowingly depend on the same `Session` interface. Telaegent detects the conflict before incompatible work is completed, obtains bounded status from Bob's Agent, proposes a human-approved division of responsibility, lets Alice continue a real coding Run, safely transfers source-backed project knowledge, blocks an attempt to access `.env`, and revises Alice's plan when Bob changes the shared contract.

The closing message is:

> Telaegent does not replace human teamwork. It lets separately owned agents coordinate routine details while people retain ownership, privacy, and authority.

