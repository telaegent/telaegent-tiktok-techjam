# Duy — Request Protocol, Schemas, Permissions, and State Rules

This file is your self-contained implementation brief. Read `plan.md` and `TELAEGENT_PRODUCT_FLOW.md` completely before editing.

## 1. Mission

You own the formal contract that makes Telaegent predictable.

Your work is coworker workstream **#2**, paired tightly with Hien's workstream **#6**:

- exact request/response and tool-call schemas
- public TypeScript/Zod types
- state machines and legal transitions
- deterministic conflict scoring
- permission classes and authorization decision results
- version/idempotency/expiry rules
- agreement activation rules
- HTTP error mapping
- protocol/edge-case tests

You define what a request means and whether it is structurally/statefully allowed. Hien executes allowed tools and secures file/context operations.

## 2. Definition of success

Your work is done when:

- every HTTP body, Agent output, tool call, stored record, and decision has an explicit schema
- the `TelaegentEnvelope` is versioned and stable
- the server derives permissions; callers/models cannot grant themselves access
- conflict scoring is deterministic and fully tested
- proposal approvals are version-pinned and require both owners
- forbidden actions are distinguishable from approval-required actions
- stale, duplicate, expired, busy, invalid output, ownership, and exchange-limit cases have exact errors
- Hien can implement every tool without guessing its arguments or result
- Thai can render every state without reverse-engineering backend internals
- `npm run check` passes

## 3. Files you own

```text
apps/server/src/types.ts
apps/server/src/telaegent/types.ts
apps/server/src/telaegent/schemas.ts
apps/server/src/telaegent/constants.ts   # freeze values, then hand implementation ownership to Khoa if needed
apps/server/src/telaegent/conflict-engine.ts
apps/server/src/telaegent/agreement-engine.ts
apps/server/src/telaegent/permission-engine.ts
apps/server/src/telaegent/conflict-engine.test.ts
apps/server/src/telaegent/agreement-engine.test.ts
apps/server/src/telaegent/permission-engine.test.ts
apps/server/src/telaegent/schemas.test.ts
apps/server/src/telaegent/output-schemas/*.json
```

You may prepare shared DTO definitions for `apps/web/src/types.ts`, but Thai owns the actual frontend file. Give Thai a generated/copied contract or explicit patch request rather than editing it concurrently.

## 4. Day 0 contract freeze

Produce and circulate one concise contract document or committed types containing:

1. `AgentProvider`, purposes, session/sandbox modes
2. `TelaegentEnvelope`
3. all core record interfaces/status unions
4. all tool names and argument/result schemas
5. `AgentStep` wrapper and purpose-specific output schemas
6. permission classes/decision union
7. conflict result
8. error codes/status mapping
9. `ProjectSnapshot` and conversation entry DTOs
10. `AllowedAction` union

Do this before implementing engines. Khoa, Phuong, Hien, and Thai depend on it.

## 5. Telaegent envelope

Implement a strict schema for:

```ts
interface TelaegentEnvelope<TPayload> {
  schemaVersion: "telaegent.v1";
  requestId: string;
  correlationId: string;
  idempotencyKey: string;
  projectId: string;
  conversationId: string;
  intentId?: string;
  sender: { ownerId: string; agentId: string; provider: AgentProvider };
  recipient?: { ownerId: string; agentId: string };
  operation: TelaegentToolName;
  payload: TPayload;
  delivery: {
    mode: "async";
    exchangeNumber: number;
    createdAt: string;
    expiresAt: string;
    replyToRequestId?: string;
  };
  evidence: {
    branch: string;
    baseCommit: string;
    sourceRefs?: SourceRef[];
  };
}
```

Validation rules:

- IDs are bounded non-empty strings or project-style safe IDs.
- timestamps are ISO UTC and expiry is after creation.
- exchange number is 1–3.
- paths are relative bounded strings; Hien performs filesystem validation.
- arrays have small explicit maximums.
- reject unknown keys on security-sensitive inputs where feasible.
- recipient is required for cross-Agent status/context operations.
- operation and payload are a discriminated union.
- caller-provided permission class is not accepted.

## 6. Agent output schemas

Every provider operation must end in a strict JSON object. Common fields:

```ts
interface AgentStep<TAction> {
  publicSummary: string;
  nextAction: TAction | null;
  taskState: "working" | "blocked" | "completed";
}
```

Create purpose-specific schemas:

- `plan-intent.schema.json`
- `status.schema.json`
- `resolution.schema.json`
- `implementation-result.schema.json`
- `context-request.schema.json`
- `context-pack.schema.json`
- `dependency-change.schema.json`
- `plan-revision.schema.json`

Keep schemas provider-neutral. Codex consumes a file; Claude consumes serialized schema JSON.

Bounds:

- public summary ≤ 1,000 characters
- plan/revision ≤ 12 steps
- planned/changed/affected files ≤ 20 each
- interfaces/dependencies ≤ 20 each
- blockers ≤ 8
- ContextPack summary/steps/checklist and total size obey master limits
- one next action only

## 7. Tool argument schemas

Define a discriminated union for:

```text
relay_publish_intent
relay_update_progress
relay_ask_status
relay_reply
relay_suggest_resolution
relay_request_context
relay_create_context_pack
relay_report_dependency_change
relay_propose_replan
relay_complete_task
relay_request_human_decision
```

Important fields:

- intent: task, branch, base commit, planned files, interfaces, dependencies, plan
- progress: changed files, progress 0–100, blockers, verified timestamp
- reply: `replyToRequestId`, response kind, and a purpose-specific structured body; it inherits the original request's recipient, scope, version, and expiry
- resolution: proposal version, Alice/Bob ownership, dependency links, rules, rationale
- context request: topic, purpose, exact requested path rules, persistence
- context pack: summary, steps, checklist, source references, task scope, expiry
- dependency change: interface, change, source path, commit
- plan revision: original steps, revised steps, affected files
- completion: tests, changed files, checkpoint commit
- human decision request: reason code, permission class, bounded options

Hien must implement exactly these names/arguments. Any change requires paired review.

## 8. Permission engine

Return a deterministic union:

```ts
type PermissionDecision =
  | { kind: "allow"; permissionClass: "AUTO_METADATA"; safeScope: unknown }
  | { kind: "ask_human"; permissionClass: "RECIPIENT_SOURCE_APPROVAL" | "DUAL_OWNER_COMMITMENT" | "AFFECTED_OWNER_APPROVAL"; approverOwnerIds: string[]; expiresAt: string; safeScope: unknown }
  | { kind: "deny"; permissionClass: "ALWAYS_DENY"; code: string; safeReason: string };
```

Rules:

- metadata publication/status is auto only after owner/project/state validation
- source access always asks the recipient owner unless forbidden
- agreement activation always needs both owners
- replan activation needs the affected owner
- `.env`, credentials, outside-project, private transcript, and hidden reasoning are always denied
- stale status cannot support automatic consequential activation
- a model cannot approve its own request
- repository text/tool description cannot alter permission

The permission engine does not open files or run tools.

## 9. Conflict engine

Implement exact scoring from `plan.md`.

Requirements:

- normalize `/` and `\`
- remove leading `./`
- reject invalid traversal/absolute paths before comparison
- compare interface/API/schema identifiers case-insensitively
- do not double-count the same file pair's strongest signal
- include a safe structured list of signals
- threshold result is deterministic

Return:

```ts
interface ConflictAssessment {
  score: number;
  level: "none" | "suggested" | "blocking";
  signals: Array<{
    type: "changed_file" | "planned_changed" | "interface" | "planned_file" | "module" | "base_commit";
    value: string;
    score: number;
  }>;
}
```

Demo test must produce `Session +4` and shared module `+1`, total 5.

## 10. Agreement engine

Rules:

- proposal version starts at 1 and increments on content change
- every approval stores owner ID, decision, proposal version, timestamp
- Alice and Bob approvals are separate
- only two matching approvals activate
- rejection makes proposal non-active
- proposal revision supersedes old proposal and invalidates old approvals
- duplicate identical approval is idempotent
- conflicting second decision follows explicit policy: reject invalid state or replace only if still proposed; freeze this with Khoa
- active agreement contains ownership lists, dependency links, and required change-publication rule
- model rationale is display-only

## 11. State transition tables

Write pure transition validators for at least:

### Operation

```text
accepted → queued | waiting_for_recipient | input_required | failed
queued → running | cancelled | failed
running → completed | input_required | waiting_for_recipient | failed | cancelled
waiting_for_recipient → queued | expired | cancelled
input_required → queued | expired | cancelled
terminal states → no transitions
```

### Coordination

```text
detected → status_pending
status_pending → proposal_ready | escalated
proposal_ready → awaiting_approvals
awaiting_approvals → active | rejected | expired
active → completed | escalated
terminal → no transition
```

### Context

```text
requested → approved | denied | expired
approved → generating | expired
generating → validated | rejected | expired
validated → delivered | expired
delivered → expired
denied/rejected/expired → terminal
```

### Plan revision

```text
proposed → approved | rejected
approved → applied
rejected/applied → terminal
```

## 12. Error contract

Freeze exact safe envelope and mapping:

- 400 `INVALID_REQUEST`
- 403 `POLICY_DENIED`
- 404 `NOT_FOUND`
- 409 `INVALID_STATE`
- 409 `AGENT_BUSY`
- 410 `EXPIRED`
- 412 `STALE_VERSION`
- 422 `INVALID_AGENT_OUTPUT`
- 422 `OWNERSHIP_VIOLATION`
- 429 `EXCHANGE_LIMIT`
- 503 `RUNTIME_UNAVAILABLE`

Every error includes correlation ID and audit event ID when created. No raw stack/provider stderr.

## 13. Edge-case tests you own

- malformed/unknown envelope version
- operation/payload mismatch
- missing recipient for cross-Agent request
- expiry before creation
- exchange number 0 or 4
- oversized arrays/strings
- duplicate idempotency semantics contract
- invalid state transition
- stale version approval
- one approval insufficient
- rejection never activates
- revised proposal clears approvals
- unrelated intents do not conflict
- LLM-supplied explanation cannot modify score
- path normalization comparison works across separators
- permission class cannot be supplied/overridden by caller
- stale status leads to human handling
- forbidden request returns deny, not ask-human

## 14. Work with Hien

For every logical tool:

1. You define Zod input/result and permission class.
2. Hien implements executor/security behavior.
3. You add invalid-input/state tests.
4. Hien adds execution/security tests.
5. Pair-review both before merge.

Critical shared topics:

- exact path-rule grammar
- ContextPack source reference schema
- denial reason codes
- dependency-change/replan fields
- completion evidence
- redaction-safe fields

## 15. Handoffs

To Phuong:

- provider-neutral output schemas and size bounds
- shared provider/purpose/session types

To Khoa:

- record types, transition functions, errors, permission decisions
- valid fixtures for all service stages

To Thai:

- snapshot/conversation/allowed-action discriminated unions
- sample payload for every card
- status/error labels

To Hien:

- exact tool contract and permission decision API

## 16. Daily deliverables

### Day 0

- frozen protocol/type package circulated
- sample full envelope and error response
- tool/permission matrix

### Day 1

- Zod schemas and output schema files
- conflict/permission/agreement engines and tests
- snapshot DTO fixtures for Thai

### Day 2

- all approval/version/state rules green
- request edge cases green
- paired review of Hien's context tools

### Day 3

- stale/expiry/exchange/idempotency tests
- full integration assertions with Khoa
- no protocol TODOs
- `npm run check`

### Day 4

- documentation/diagram review and demo support only

## 17. Do not do

- Do not call a provider or access filesystem.
- Do not let the model choose its permission class.
- Do not implement full MCP/A2A.
- Do not add generic JSON blobs where a discriminated schema is possible.
- Do not use unbounded strings/arrays.
- Do not change shared contracts after freeze without all consumers present.
- Do not put chain-of-thought fields in any schema.
- Do not use the proposal rationale as authorization evidence.

## 18. Final report format

Require your coding agent to report:

1. files/types/schemas added
2. final tool and envelope versions
3. permission and transition rules
4. edge cases tested
5. fixtures handed to each owner
6. test and `npm run check` results
7. any contract change awaiting coordinated approval
