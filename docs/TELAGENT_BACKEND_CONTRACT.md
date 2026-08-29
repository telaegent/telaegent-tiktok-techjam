# Telagent Backend Orchestration Contract

Status: Khoa-owned orchestration contract frozen for Day 1 implementation  
Date: 2026-08-28  
Scope: persistence, Operations, orchestration, HTTP routes, and project snapshots

This document fixes the integration boundary for Khoa's backend work without
taking ownership of Duy's public domain types, Phuong's runtime adapter,
Hien's policy/tool services, or Thai's frontend components.

The canonical product sequence remains:

> Publish intent -> detect conflict -> exchange structured status -> propose a
> resolution -> obtain separate human approvals -> transfer a permissioned,
> source-backed ContextPack -> detect dependency changes -> adapt affected
> plans -> complete with an auditable history.

## 1. Existing Starter Kit seams

Telagent extends these existing files and responsibilities:

- `JsonStore` remains the only JSON persistence mechanism and mutation queue.
- `AgentService` remains the only owner of Agent busy state, Runs,
  cancellation, and provider session updates.
- `createApp` remains the Fastify composition and error boundary.
- `index.ts` constructs dependencies and performs startup reconciliation.
- Existing Agent CRUD, messages, Runs, Playground behavior, and database
  version remain compatible.

No Telagent service or route may call an `AgentRunner` directly.

## 2. Persistence contract

The version-1 database gains one property:

```ts
interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  telagent: TelagentDatabase;
}
```

`TelagentDatabase` contains these arrays:

```text
projects
owners
agentBindings
conversations
conversationEntries
intents
coordinationRequests
agreements
contextRequests
contextPacks
dependencyChanges
planRevisions
operations
events
idempotencyRecords
```

Rules:

1. Reading a version-1 database without `telagent` normalizes it to the empty
   shape without changing existing Agent data.
2. `snapshot()` always returns a complete normalized shape.
3. State transition and corresponding audit event are written by one queued,
   atomic `store.mutate()` call.
4. Event `sequence` is allocated inside that mutation as the previous global
   maximum plus one. It is monotonically increasing across the JSON database.
5. The store queue is never held while awaiting an Agent run, filesystem tool,
   Git operation, or human response.
6. A long operation uses prepare/run/apply: create records atomically, release
   the queue, perform work, then validate and atomically apply the result.
7. Failed persistence never publishes the candidate state in memory.

Persist only safe coordination records. Never persist runtime prompts, hidden
reasoning, complete provider transcripts, raw rejected output, denied file
contents, credentials, environment values, or provider home/session files.

## 3. Operation contract

Operation states are:

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

Allowed lifecycle edges:

```text
accepted -> queued | waiting_for_recipient | input_required | failed
queued -> running | cancelled | failed
running -> completed | waiting_for_recipient | input_required | failed | cancelled | escalated
waiting_for_recipient -> queued | expired | cancelled | escalated
input_required -> queued | expired | cancelled | escalated
```

Terminal states are `completed`, `failed`, `cancelled`, `expired`, and
`escalated`. Terminal Operations cannot resume or accept a reply.

Every long-running mutation returns HTTP `202` before provider completion:

```json
{
  "operationId": "op_01",
  "requestId": "req_01",
  "correlationId": "corr_01",
  "state": "accepted",
  "pollUrl": "/api/telagent/operations/op_01"
}
```

Idempotency scope is project + sender + operation + idempotency key. A
duplicate request returns the original Operation and never duplicates an
approval, ContextPack, dependency change, or audit transition.

## 4. Restart contract

At server startup:

- Preserve the Starter Kit's existing Run reconciliation.
- Mark Telagent Operations associated with queued/running Runs failed or
  cancelled with a safe restart reason.
- Keep unexpired `waiting_for_recipient` and `input_required` records.
- Expire records whose TTL elapsed.
- Never replay a provider call automatically.
- Never discard an attributable audit history.

## 5. AgentService seam owned by Phuong

Khoa's orchestrator consumes, but does not implement, this logical seam:

```ts
runMiddlewareTurn(request: MiddlewareRunRequest): Promise<NormalizedRunResult<unknown>>
```

The request must carry Agent, provider, purpose, workspace, internal runtime
prompt, bounded persisted summary, session mode, sandbox mode, network mode,
output schema name, correlation ID, and maximum turns.

The result must carry provider, optional owning session ID, candidate final
object, changed files, exit code, and duration. Raw prompts and raw output stay
inside the runtime boundary until validated. `fresh` and `ephemeral` runs must
not replace the owning Agent's persistent session.

## 6. Policy/tool seams owned by Duy and Hien

The orchestrator requires the following deterministic collaborators:

```text
schemaForPurpose.parse(candidate)
permissionEngine.evaluate(action, state, actor)
conflictEngine.evaluate(intents)
agreementEngine.recordDecision(agreement, actor, version, decision)
toolDispatcher.execute(validatedAction)
contextPackService.generateAndValidate(approvedRequest)
dependencyImpact.detect(change, activeState)
redaction.sanitizePublicValue(value)
```

The model may propose a tool call. Only schemas and deterministic services may
authorize or execute it. Human-only decisions are never exposed as freely
callable model tools.

## 7. Conversation orchestrator contract

Each canonical stage has an explicit service entry point and a purpose-specific
schema/tool allowlist. The loop is limited to three internal steps:

1. Build an internal prompt from safe current state.
2. Call `AgentService.runMiddlewareTurn()`.
3. Parse the result using the stage schema.
4. Persist only a bounded, redacted `publicSummary`.
5. If there is no next action, complete the stage.
6. Evaluate the one proposed action deterministically.
7. Deny it, pause for a human, or dispatch it.
8. Append a safe tool call/result observation.
9. Resume the same owning Agent session when allowed.
10. Escalate after the step or exchange limit.

Human decisions resume a new queued continuation pinned to the exact persisted
request/proposal/revision version. They do not continue an open HTTP request or
hold a store lock.

## 8. TelagentService methods

The service exposes focused methods rather than a generic workflow switch:

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

Every mutating method validates actor, project, state, version, TTL, and
idempotency before applying a transition and audit event atomically.

## 9. HTTP route contract

All routes use `/api/telagent`:

```text
POST /demo/initialize
POST /demo/reset
GET  /runtime-capabilities
GET  /projects/:projectId/snapshot
GET  /operations/:operationId
POST /conversations/:conversationId/messages
POST /intents/:intentId/continue
POST /intents/:intentId/complete
POST /coordination/:requestId/status
POST /coordination/:requestId/proposal
POST /agreements/:agreementId/decision
POST /context-requests
POST /context-requests/:requestId/decision
POST /context-requests/:requestId/generate
POST /intents/:intentId/dependency-change
POST /impacts/:impactId/replan
POST /replans/:revisionId/decision
```

Route rules:

- Zod-parse params and bodies before calling the service.
- Return `202` Operation handles for long work.
- Return safe 404 responses for unknown records.
- Map domain errors to Duy's error envelope.
- Never serialize raw exceptions, provider stderr, prompts, or session IDs.
- Preserve existing non-Telagent routes unchanged.

## 10. Project snapshot contract

`GET /api/telagent/projects/phoenix/snapshot` is the authoritative frontend
read model. It contains:

```ts
interface ProjectSnapshot {
  project: SafeProject;
  owners: Owner[];
  agentBindings: SafeAgentBinding[];
  conversation: CoordinationConversation;
  entries: ConversationEntry[];
  intents: Intent[];
  coordinationRequests: CoordinationRequest[];
  agreements: Agreement[];
  contextRequests: ContextRequest[];
  contextPacks: ContextPack[];
  dependencyChanges: DependencyChange[];
  planRevisions: PlanRevision[];
  operations: Operation[];
  events: AuditEvent[];
  allowedActions: AllowedAction[];
  generatedAt: string;
}
```

Collections are ordered deterministically: conversation entries and audit
events by sequence, Operations and domain records by creation time then ID.

`allowedActions` is computed by the server from acting owner, state, version,
TTL, policy, and active agreement. React must not derive authorization from
raw record state. Required action discriminators include:

```text
approve_agreement
deny_agreement
decide_context
generate_context_pack
approve_replan
continue_intent
retry_operation
```

The snapshot never exposes provider session IDs, absolute private host paths,
runtime prompts, hidden reasoning, complete transcripts, or denied contents.

## 11. Error contract

Domain errors use:

```json
{
  "error": {
    "code": "POLICY_DENIED",
    "message": "The requested path is always forbidden.",
    "safeDetails": { "rule": "FORBID_ENV_FILES" },
    "correlationId": "corr_01",
    "auditEventId": "evt_01"
  }
}
```

Required codes are `INVALID_REQUEST`, `POLICY_DENIED`, `INVALID_STATE`,
`AGENT_BUSY`, `EXPIRED`, `STALE_VERSION`, `INVALID_AGENT_OUTPUT`,
`OWNERSHIP_VIOLATION`, `EXCHANGE_LIMIT`, and `RUNTIME_UNAVAILABLE`.

## 12. Freeze and change policy

- Duy's TypeScript types and schemas must map to this orchestration contract;
  Duy retains ownership of their definitions.
- Phuong's runtime implementation must satisfy the AgentService seam;
  Phuong retains ownership of runtime mechanics.
- Hien's dispatcher and security services must satisfy the deterministic
  collaborators; Hien retains ownership of their implementation.
- Thai consumes the snapshot and `allowedActions`; Thai does not recreate
  policy in React.
- After the TypeScript contracts land, changes to route paths, Operation
  semantics, or snapshot fields are additive unless all affected owners agree.
