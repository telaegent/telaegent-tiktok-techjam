# Khoa — Backend Orchestrator, Shared Memory, and Integration Lead

This file is your self-contained implementation brief. Read `plan.md` and `TELAEGENT_PRODUCT_FLOW.md` completely before editing.

## 1. Mission

You own Telaegent's backend coordination brain and final integration.

Your work covers coworker workstream **#4** and the orchestration half of **#5**:

- decide and implement what coordination memory is persisted
- extend the existing JSON database safely
- implement Operations for long-running and unanswered requests
- orchestrate the bounded conversation-centered Agent loop
- expose routes and one authoritative frontend snapshot
- pause/resume after human approval
- reconcile cancellation/restart
- preserve audit history
- integrate all five workstreams without weakening boundaries

You do not implement provider process mechanics, permission algorithms, frontend components, or ContextPack filesystem isolation.

## 2. Definition of success

Your work is done when:

- old Starter Kit database data loads without loss
- all Telaegent state is persisted under one compatible `telaegent` property
- each long operation returns HTTP `202` immediately
- unanswered recipient/human requests survive refresh and are visible in the correct owner inbox
- human decisions resume the exact paused version, not stale work
- `TelaegentService` never calls a runner directly
- all Agent execution goes through Phuong's `AgentService` seam
- raw prompts/private transcripts/unvalidated output never enter shared memory
- one project snapshot reconstructs the full conversation and valid actions
- restart marks interrupted Operations safely while keeping pending human requests
- the canonical end-to-end flow passes through Fastify with fake runners
- normal Agent routes and Playground remain intact
- `npm run check` passes

## 3. Files you own

```text
apps/server/src/store.ts
apps/server/src/app.ts
apps/server/src/index.ts
apps/server/src/telaegent/service.ts
apps/server/src/telaegent/routes.ts
apps/server/src/telaegent/conversation-orchestrator.ts
apps/server/src/telaegent/constants.ts   # after Duy freezes protocol constants
apps/server/src/telaegent/service.test.ts
apps/server/src/telaegent/routes.test.ts
```

Coordinate before editing:

- `apps/server/src/types.ts` and `telaegent/types.ts` — Duy owns public types
- `apps/server/src/agent-service.ts` — Phuong owns runtime seam
- tool/policy/context/Git/fixture files — Hien owns
- frontend — Thai owns

You are merge gatekeeper, but that does not authorize rewriting another owner's module without a handoff.

## 4. Contracts to freeze on Day 0

With Phuong:

- `MiddlewareRunRequest`
- `NormalizedRunResult`
- provider session rules
- run lifecycle/cancellation callback
- safe runtime error codes

With Duy:

- database record types
- state transition tables
- `TelaegentEnvelope`
- error envelope
- version/idempotency semantics

With Hien:

- tool dispatcher input/result
- ContextPack generate/validate service calls
- Git/fixture interfaces
- dependency impact result

With Thai:

- `ProjectSnapshot`
- `allowedActions`
- mutation response/Operation format
- card entry payload discriminators

Freeze the snapshot by Day 1 noon. Later changes should be additive.

## 5. Memory decision you must enforce

The JSON store is **coordination memory**, not a dump of Agent memory.

Persist:

- Projects, owners, bindings
- safe conversation entries
- intents and checkpoints
- conflict evidence
- proposals, approvals, agreements
- context request decisions and validated pack
- dependency changes and plan revisions
- Operations, audit events, idempotency records

Never persist:

- runtime prompt
- hidden reasoning
- complete provider transcript/JSONL
- raw rejected provider output
- denied file contents
- credentials or environment values
- provider home/session files

Provider session ID may live only on the owning Agent binding. It is never shown to or injected into the other Agent.

## 6. Persistence implementation

### 6.1 Backward-compatible database extension

Extend the existing version-1 database with:

```ts
telaegent: {
  projects: [],
  owners: [],
  agentBindings: [],
  conversations: [],
  conversationEntries: [],
  intents: [],
  coordinationRequests: [],
  agreements: [],
  contextRequests: [],
  contextPacks: [],
  dependencyChanges: [],
  planRevisions: [],
  operations: [],
  events: [],
  idempotencyRecords: []
}
```

- Do not increment the database version unless the actual store requires it.
- Normalize missing `telaegent` to the empty shape at read time.
- Keep existing queued mutation and atomic temp-write/rename behavior.
- Generate audit event sequence inside the same atomic mutation as the corresponding state transition.
- Never hold the store queue while awaiting an Agent run.

### 6.2 Transaction pattern

For long work:

1. Atomic mutation validates state/version and creates Operation + audit event.
2. Release store lock.
3. Start Agent/tool work.
4. Validate result through Duy/Hien services.
5. Atomic mutation applies result, state transition, conversation entries, and audit event.

If step 3 fails, step 5 records a safe failure.

## 7. Operation and unanswered-request design

Required Operation states:

```text
accepted
queued
running
waiting_for_recipient
input_required
completed
failed
cancelled
expired
escalated
```

### 7.1 New request

- Parse and validate through Duy's schema.
- Check idempotency.
- Create Operation and initial conversation entry.
- Return `202` with `operationId`, `requestId`, `correlationId`, `state`, and `pollUrl`.
- Continue work asynchronously after the response.

### 7.2 Recipient has not answered

- Persist the request with recipient Agent/owner, exact version, purpose, safe scope, and expiry.
- Set Operation to `waiting_for_recipient` or `input_required`.
- Add it to the recipient's `allowedActions`/inbox in snapshot.
- Do not keep an HTTP request, process, or store lock open.
- Page refresh must reconstruct it.
- On reply, atomically validate actor, state, version, and TTL, then queue resume.

### 7.3 Restart

On server startup:

- reuse existing behavior for Agent runs
- mark Telaegent Operations tied to queued/running runs as failed/cancelled with a safe restart reason
- keep `waiting_for_recipient` and `input_required` requests if still valid
- expire records past TTL
- do not auto-repeat provider calls

### 7.4 Idempotency

Key scope: project + sender + operation + idempotency key.

- duplicate mutation returns original Operation
- never duplicate approval, ContextPack generation, or dependency change
- keep idempotency records for the local demo database lifetime

## 8. Conversation orchestrator

Implement the bounded loop from `plan.md`:

1. Choose purpose-specific output schema/tool allowlist.
2. Build internal runtime prompt from safe current state.
3. Call `AgentService.runMiddlewareTurn()`.
4. Ask Duy's schema to parse result.
5. Append only safe `publicSummary`.
6. If no tool: complete current stage.
7. If tool: ask Duy's permission engine.
8. Deny, pause for a human, or call Hien's dispatcher.
9. Append safe tool call/result.
10. Resume the same Agent session with the observation when allowed.
11. Stop after maximum 3 internal steps.

Do not implement a generic autonomous loop. Each canonical stage has an explicit service method and known allowed tools.

## 9. Telaegent service methods

Implement clear methods instead of one giant switch:

```text
initializeDemo
resetDemo
submitConversationMessage
publishIntentCandidate
requestRecipientStatus
createResolutionProposal
decideAgreement
continueIntent
createContextRequest
decideContextRequest
generateContextPack
publishDependencyChange
requestPlanRevision
decidePlanRevision
completeIntent
getProjectSnapshot
getOperation
reconcileOnStartup
```

Every method must validate state and actor, use deterministic engines, create audit evidence, and return safe DTOs.

## 10. Routes

Mount the `/api/telaegent` APIs listed in `plan.md`.

Rules:

- Zod-parse params/body.
- Long work returns `202` before provider completion.
- State/version/policy errors use Duy's exact error envelope.
- Unknown record returns safe 404.
- Never send raw exceptions or provider stderr.
- Use Fastify injection tests for every decision route.

## 11. Snapshot and frontend contract

One `GET /projects/phoenix/snapshot` response must contain:

- project and runtime-safe Agent bindings
- acting owners
- safe shared conversation entries in sequence order
- intents
- active coordination/agreement
- context request/pack
- dependency change/revision
- active Operations
- audit events
- server-computed `allowedActions`

`allowedActions` examples:

```ts
type AllowedAction =
  | { type: "approve_agreement"; agreementId: string; version: number; ownerId: string }
  | { type: "deny_agreement"; agreementId: string; version: number; ownerId: string }
  | { type: "decide_context"; requestId: string; version: number; ownerId: string }
  | { type: "generate_context_pack"; requestId: string }
  | { type: "approve_replan"; revisionId: string; version: number; ownerId: string }
  | { type: "continue_intent"; intentId: string }
  | { type: "retry_operation"; operationId: string };
```

React must not recreate policy from raw states.

## 12. Shared conversation safety

Allowed entry payloads are discriminated DTOs. Do not place arbitrary provider text into `payload`.

Before appending:

- limit public summary length
- pass through Hien's redaction helper
- keep relative paths only
- omit provider session ID
- omit internal prompt and stack trace
- attach correlation/audit IDs

The Audit Timeline is derived from events, not from parsing conversation text.

## 13. API/security answer for the README

Coordinate with Phuong and document honestly:

- local browser/server uses loopback HTTP
- server/provider uses local process/container boundaries
- no custom end-to-end encryption in MVP
- remote hosting requires HTTPS
- JSON database is not encrypted at rest
- security comes from data minimization, local scope, deterministic authorization, isolation, and no secret persistence

Do not claim production-grade identity or encryption.

## 14. Tests you must write

- old database loads with empty Telaegent shape
- event sequence monotonic under concurrent mutations
- duplicate idempotency key returns original Operation
- stale version approval returns 412
- one owner approval does not activate agreement
- second matching approval activates exactly once
- waiting request survives service recreation
- expired request cannot resume
- running operation reconciles safely after restart
- raw prompt/output/denied data absent from serialized store
- snapshot ordering and `allowedActions` correct
- route errors match exact envelope
- normal Agent routes remain green
- full canonical workflow test passes with fake runners and Hien's fixture

## 15. Daily deliverables

### Day 1

- data backfill and store tests
- service/routes/Operation skeleton
- initialize + snapshot
- conversation submission through conflict with fake runners
- snapshot fixture committed for Thai by noon

### Day 2

- status/proposal/dual approval
- loop pause/resume
- context request waiting/resume
- flow through validated ContextPack

### Day 3

- dependency/replan/completion
- restart/idempotency/expiry
- full Fastify integration test
- integrate real providers
- full `npm run check`

### Day 4

- fresh-clone validation, README, diagram, demo support
- only P0 bug fixes

## 16. Integration responsibilities

- Merge Duy's shared schemas before service code relies on them.
- Do not accept a Phuong runner change that bypasses AgentService state.
- Do not accept a Hien tool that evaluates its own human permission.
- Do not accept frontend code that invents allowed actions.
- Keep integration branch green at both daily windows.
- Resolve contract conflicts by preserving the master plan's trust boundary.

## 17. Do not do

- Do not add PostgreSQL, SQLite, Redis, vector search, or a message broker.
- Do not store complete Agent sessions or memory.
- Do not wait synchronously for recipient approval.
- Do not call runners directly.
- Do not let one API call perform an unbounded loop.
- Do not auto-retry a provider run after restart.
- Do not mix raw domain records with frontend-calculated authorization.
- Do not implement production auth or remote callbacks.

## 18. Final report format

Require your coding agent to report:

1. files changed
2. state transitions implemented
3. persisted vs non-persisted data
4. async/wait/restart behavior
5. route/snapshot contract
6. tests and `npm run check` result
7. integration blockers by owner

