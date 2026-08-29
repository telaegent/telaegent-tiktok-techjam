# Telaegent protocol contract v1

Status: frozen Day-0 contract for the two-agent Phoenix MVP  
Owner: Duy  
Logical schema version: `telaegent.v1`

## Contract boundary

All Agent-originated operations pass through the strict `TelaegentRequest` union in `apps/server/src/telaegent/types.ts` and `telaegentEnvelopeSchema` in `schemas.ts`.

```text
parse -> authenticate -> normalize identity -> validate state/version/expiry
      -> check idempotency -> derive permission -> persist operation/event -> execute
```

The request body never grants permission. `sender` is a claim that must match the authenticated AgentBinding; `provider` is authoritative only after it is derived or checked against that binding.

## Identifiers

| Identifier | Owner | Purpose |
|---|---|---|
| `requestId` | original sender | One logical request |
| `correlationId` | ingress | Logs and audit correlation only |
| `idempotencyKey` | sender, validated by server | Deduplicate project + sender + operation |
| `conversationId` | Telaegent | Related coordination entries |
| `intentId` | Telaegent | One owner/Agent work intent |
| `operationId` | Telaegent server | Durable asynchronous execution |
| `artifactId` | Telaegent server | Validated ContextPack/result artifact |

IDs are bounded opaque strings. They are not credentials and never replace authorization.

## Envelope invariants

- Exact version `telaegent.v1`.
- Operation and payload are a strict discriminated union.
- Unknown security-sensitive fields are rejected.
- `delivery.mode` is `async`; `exchangeNumber` is 1–3.
- Timestamps are UTC with millisecond precision; expiry is after creation.
- Cross-Agent status, reply, resolution, context, ContextPack, and replan operations require a distinct recipient.
- A reply carries matching payload and delivery `replyToRequestId` values.
- Paths are bounded relative paths; context rules support only exact files and `directory/**`.
- `permissionClass`, approval, score, task state, and safe scope are never caller inputs.

## Tool contract

| Tool | Required payload | Derived permission |
|---|---|---|
| `relay_publish_intent` | task, branch, base commit, planned files, interfaces, dependencies, plan | `AUTO_METADATA` |
| `relay_update_progress` | changed files, progress 0–100, blockers, verified timestamp | `AUTO_METADATA` |
| `relay_ask_status` | target intent, purpose | `AUTO_METADATA` with stale handling |
| `relay_reply` | original request ID, response kind, typed response body | Inherits original request; cannot expand scope |
| `relay_suggest_resolution` | request/intents, proposal version, ownership, links, rules, rationale | `DUAL_OWNER_COMMITMENT` |
| `relay_request_context` | topic, purpose, exact path rules, persistence | `RECIPIENT_SOURCE_APPROVAL` |
| `relay_create_context_pack` | request, summary, steps, checklist, sources, scope, expiry | Existing source approval required |
| `relay_report_dependency_change` | interface, change, source path, commit | `AUTO_METADATA` |
| `relay_propose_replan` | dependency change, original/revised steps, affected files | `AFFECTED_OWNER_APPROVAL` |
| `relay_complete_task` | test evidence, changed files, checkpoint commit | Auto only after ownership/evidence checks |
| `relay_request_human_decision` | reason code, safe reason, 2–4 bounded options | Derived from reason; no permission-class input |

Provider outputs use the common wrapper:

```ts
interface AgentStep<TAction> {
  publicSummary: string;        // max 1,000 characters
  nextAction: TAction | null;   // at most one, purpose allowlisted
  taskState: "working" | "blocked" | "completed";
}
```

The eight committed JSON Schemas in `apps/server/src/telaegent/output-schemas/` are generated from the authoritative Zod schemas and tested for synchronization.

## Permission decisions

```ts
type PermissionDecision =
  | { kind: "allow"; permissionClass: "AUTO_METADATA"; safeScope: unknown }
  | {
      kind: "ask_human";
      permissionClass:
        | "RECIPIENT_SOURCE_APPROVAL"
        | "DUAL_OWNER_COMMITMENT"
        | "AFFECTED_OWNER_APPROVAL";
      approverOwnerIds: string[];
      expiresAt: string;
      safeScope: unknown;
    }
  | {
      kind: "deny";
      permissionClass: "ALWAYS_DENY";
      code: string;
      safeReason: string;
    };
```

Always deny before file access: `.env`, `.env.*`, `.git/**`, secret/credential/token/private-key-like paths, outside-project actors/resources, private transcripts, and hidden reasoning. Only a human in `approverOwnerIds` may approve; an Agent cannot approve its own request.

## Deterministic conflict scoring

| Signal | Score |
|---|---:|
| Same currently modified file | 5 |
| Planned file overlaps modified file | 4 |
| Same interface/API/schema | 4 |
| Same planned file | 3 |
| Same immediate module/directory | 1 |
| Different non-empty base commits | 1 |

The strongest exact-file signal is counted once. Interfaces compare case-insensitively. Scores 0–2 are `none`, 3–4 `suggested`, and 5+ `blocking`. The Phoenix fixture produces `Session +4` and `src/auth +1`, total 5.

## Agreement rules

- Proposal version starts at 1 and increments only on content change.
- Each approval stores owner, decision, exact proposal version, and timestamp.
- One approval is insufficient; both participant owners must approve the same version.
- Rejection never activates; revision clears old approvals.
- Identical duplicate approval is idempotent; conflicting replacement is `INVALID_STATE`.
- Active/completed agreements cannot be revised in place.
- Model rationale is display-only and never authorization evidence.

## State transitions

### Operation

```text
accepted -> queued | waiting_for_recipient | input_required | failed
queued -> running | cancelled | failed
running -> completed | input_required | waiting_for_recipient | failed | cancelled | escalated
waiting_for_recipient -> queued | expired | cancelled | escalated
input_required -> queued | expired | cancelled | escalated
terminal -> no transition
```

### Coordination

```text
detected -> status_pending
status_pending -> proposal_ready | escalated
proposal_ready -> awaiting_approvals
awaiting_approvals -> active | rejected | expired
active -> completed | escalated
terminal -> no transition
```

### Context

```text
requested -> approved | denied | expired
approved -> generating | expired
generating -> validated | rejected | expired
validated -> delivered | expired
delivered -> expired
denied | rejected | expired -> terminal
```

### Plan revision

```text
proposed -> approved | rejected
approved -> applied
rejected | applied -> terminal
```

## Errors

| HTTP | Code |
|---:|---|
| 400 | `INVALID_REQUEST` |
| 403 | `POLICY_DENIED` |
| 404 | `NOT_FOUND` |
| 409 | `INVALID_STATE` |
| 409 | `AGENT_BUSY` |
| 410 | `EXPIRED` |
| 412 | `STALE_VERSION` |
| 422 | `INVALID_AGENT_OUTPUT` |
| 422 | `OWNERSHIP_VIOLATION` |
| 429 | `EXCHANGE_LIMIT` |
| 503 | `RUNTIME_UNAVAILABLE` |

Every safe error includes code, message, correlation ID, optional safe details, and audit-event ID when one exists. It never includes provider stderr, raw prompt/output, a stack, credentials, or local home paths.

## Idempotency and expiry

- Scope: project + authenticated sender Agent + operation + idempotency key.
- Persist a canonical validated-request fingerprint, request ID, and Operation ID.
- Exact duplicate returns the original Operation and never starts a second execution.
- Same key with a different fingerprint fails safely.
- Decisions include `targetVersion`; stale decisions return `412 STALE_VERSION`.
- Terminal Operations reject replies; responses after expiry return `410 EXPIRED`.

## Bounds

- Summary 1,000 characters; task 2,000.
- Plan/revision 12 steps; files 20; interfaces/dependencies 20; blockers 8.
- Source references 8; approved path rules 5; ContextPack JSON 8 KiB.
- ContextPack TTL 15 minutes; status stale after 5 minutes; coordination TTL 30 minutes.
- Three Agent steps and three inter-Agent exchanges maximum.

## Handoff files

- Khoa: `types.ts`, `constants.ts`, `state-machine.ts`, `errors.ts`, and `EMPTY_TELAEGENT_DATABASE`.
- Phuong: provider-neutral runtime types and eight purpose-specific output schemas.
- Hien: `PayloadByOperation`, strict payload schemas, permission API, path grammar, and envelope fixtures.
- Thai: `ProjectSnapshot`, `ConversationEntry`, `AllowedAction`, and card/action fixtures.

Any change to tool names, payloads, permission classes, versions, error codes, or transitions requires coordinated review by the dependent owners.
