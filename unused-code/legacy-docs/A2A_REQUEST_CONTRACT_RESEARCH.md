# Defining an A2A request for Telagent

**Decision memo for Duy's protocol workstream**  
**Research date:** 2026-08-28  
**Target:** Telagent two-agent MVP on Fastify, TypeScript, Zod, and Vitest

## Executive decision

For Telagent, an “A2A request” should be defined as two contracts joined by an adapter:

1. **Canonical Telagent contract:** a strict, versioned `TelagentEnvelopeV1` discriminated by `operation`, used by the permission, state, agreement, conflict, persistence, and queueing code.
2. **A2A interoperability contract:** the official A2A v1 `SendMessageRequest`, with the Telagent envelope carried in a structured `Part.data` under a required, versioned Telagent extension.

The current A2A patch release is **v1.0.1**, but protocol negotiation intentionally uses only **`A2A-Version: 1.0`**. The tagged release calls v1.0.1 the latest, and the specification makes the protobuf definition authoritative. [A2A v1.0.1 release](https://github.com/a2aproject/A2A/releases/tag/v1.0.1), [normative v1.0.1 proto](https://raw.githubusercontent.com/a2aproject/A2A/v1.0.1/specification/a2a.proto), [A2A normative-content rules](https://a2a-protocol.org/latest/specification/#14-normative-content)

This is deliberately **A2A-inspired at the MVP boundary, not a claim of full A2A compliance**. That matches `duy.md`, which explicitly excludes implementing full MCP/A2A while requiring an exact internal protocol.

## The boundary to freeze

| Layer | Owner | Purpose | Validation rule |
|---|---|---|---|
| HTTP or A2A binding | Route/adapter | Authentication, protocol version, content type, transport response | Binding-specific |
| Telagent envelope | Duy | Stable domain meaning, identity claims, routing, expiry, evidence | Strict Zod schema |
| Operation payload | Duy + Hien | Exact arguments for one `relay_*` tool | Strict discriminated union |
| Permission decision | Duy | Server-derived allow/approval/deny result | Never accepted from caller |
| Operation/Task record | Khoa + Duy | Durable async lifecycle and replay result | Legal transitions only |

The request path should be explicit:

```text
parse binding -> authenticate -> validate Telagent data -> normalize identity
              -> check version/expiry/idempotency -> derive permission
              -> persist operation -> enqueue or await approval
```

Authentication must happen outside the message body. A2A expects credentials at the transport layer and requires authorization per operation; therefore, `sender` fields in JSON are claims, not proof. The authoritative sender and provider come from the authenticated session/AgentBinding. [A2A authentication and authorization](https://a2a-protocol.org/latest/specification/#7-authentication-and-authorization)

## What the official A2A request contains

A2A separates an operation parameter object from its protocol binding. The standard application object is:

```ts
interface SendMessageRequest {
  tenant?: string;
  message: Message;                  // required
  configuration?: {
    acceptedOutputModes?: string[];
    taskPushNotificationConfig?: unknown;
    historyLength?: number;
    returnImmediately?: boolean;
  };
  metadata?: Record<string, unknown>;
}
```

A request `Message` requires a sender-created `messageId`, `role: "ROLE_USER"`, and a non-empty `parts` array. In v1, each `Part` contains exactly one of `text`, `raw`, `url`, or `data`; there is no v0.3-style `kind` discriminator. JSON names are camelCase and enum values use ProtoJSON `SCREAMING_SNAKE_CASE`. [A2A Message and Part definitions](https://raw.githubusercontent.com/a2aproject/A2A/v1.0.1/specification/a2a.proto#L211-L265), [A2A v1 Part redesign](https://a2a-protocol.org/latest/whats-new-v1/#part-object)

A2A does **not** define Telagent's operation names, owner/recipient IDs, intent IDs, Git evidence, exchange limit, permission classes, approval versions, or ContextPack rules. Those belong in a Telagent extension, not as modifications to the base A2A schema. A2A supports this through advertised, opt-in, versioned extension URIs; breaking extension changes require a new URI. [A2A extensions](https://a2a-protocol.org/latest/specification/#46-extensions)

## Recommended canonical Telagent request

Keep the planned envelope, with two security corrections:

- Treat `sender` as **server-normalized**. If ingress accepts sender IDs, compare them with the authenticated principal and reject mismatches. Never trust `provider` from JSON; derive it from the AgentBinding.
- Do not accept `permissionClass`, approval state, conflict score, or authorization evidence in any operation payload. Those are server results.

```ts
type TelagentToolName =
  | "relay_publish_intent"
  | "relay_update_progress"
  | "relay_ask_status"
  | "relay_reply"
  | "relay_suggest_resolution"
  | "relay_request_context"
  | "relay_create_context_pack"
  | "relay_report_dependency_change"
  | "relay_propose_replan"
  | "relay_complete_task"
  | "relay_request_human_decision";

type PayloadByOperation = {
  relay_publish_intent: PublishIntentInput;
  relay_update_progress: UpdateProgressInput;
  relay_ask_status: AskStatusInput;
  relay_reply: ReplyInput;
  relay_suggest_resolution: SuggestResolutionInput;
  relay_request_context: RequestContextInput;
  relay_create_context_pack: CreateContextPackInput;
  relay_report_dependency_change: DependencyChangeInput;
  relay_propose_replan: ProposeReplanInput;
  relay_complete_task: CompleteTaskInput;
  relay_request_human_decision: HumanDecisionRequestInput;
};

interface TelagentEnvelopeV1<T extends TelagentToolName> {
  schemaVersion: "telagent.v1";
  requestId: string;
  correlationId: string;
  idempotencyKey: string;
  projectId: string;
  conversationId: string;
  intentId?: string;
  sender: {
    ownerId: string;
    agentId: string;
    provider: AgentProvider; // server-derived before domain handling
  };
  recipient?: {
    ownerId: string;
    agentId: string;
  };
  operation: T;
  payload: PayloadByOperation[T];
  delivery: {
    mode: "async";
    exchangeNumber: 1 | 2 | 3;
    createdAt: string;       // RFC 3339 UTC
    expiresAt: string;       // RFC 3339 UTC, after createdAt
    replyToRequestId?: string;
  };
  evidence: {
    branch: string;
    baseCommit: string;
    sourceRefs?: SourceRef[];
  };
}
```

Implement the public union as one schema per operation, then combine it with `z.discriminatedUnion("operation", [...])`. Do not implement `payload` as `z.unknown()` or a generic record. Use `.strict()` on the Telagent envelope and security-sensitive nested objects. Bound every identifier, string, array, and structured-data depth.

### Fields and ownership

| Field | Created by | Meaning | A2A mapping |
|---|---|---|---|
| `requestId` | Original sender | Unique logical request/message | `message.messageId` |
| `conversationId` | Telagent/server, or accepted client context | Related coordination thread | `message.contextId` |
| `intentId` | Telagent domain | Planned work identity | Telagent `Part.data` only |
| `correlationId` | Ingress/tracing layer | Logs and audit correlation; no replay semantics | A2A request metadata or trace context |
| `idempotencyKey` | Caller, validated by server | Deduplicates one logical mutation | Telagent extension; not A2A core |
| `operationId` | Telagent server | Durable async execution record | Usually maps to an A2A `taskId` at the adapter |
| `taskId` | A2A server | A2A Task identity; never invented for a new task by a client | `message.taskId` on continuation only |
| JSON-RPC `id` | JSON-RPC client | Correlates one transport request and response | JSON-RPC binding only |

Do not collapse these identifiers. JSON-RPC `id` is only correlation at that binding. A2A assigns `messageId` to the message creator and new Task IDs to the server. If a follow-up supplies both `taskId` and `contextId`, they must match the stored Task; if it supplies only `taskId`, the server may infer its context. [JSON-RPC 2.0 request object](https://www.jsonrpc.org/specification#request_object), [A2A multi-turn identifier semantics](https://a2a-protocol.org/latest/specification/#34-multi-turn-interactions)

## A2A HTTP+JSON adapter example

HTTP+JSON is the best later adapter for this repository because the server is already Fastify/REST. JSON-RPC and gRPC are valid A2A bindings but add no MVP value.

Use a team-controlled stable HTTPS URI when one exists. Until then, the URN below is explicitly provisional:

```http
POST /message:send HTTP/1.1
Content-Type: application/a2a+json
A2A-Version: 1.0
A2A-Extensions: urn:telagent:extension:coordination:v1
Authorization: Bearer <redacted>
```

```json
{
  "message": {
    "messageId": "req_01JTELAGENT42",
    "contextId": "conv_phoenix_7",
    "role": "ROLE_USER",
    "parts": [
      {
        "data": {
          "schemaVersion": "telagent.v1",
          "requestId": "req_01JTELAGENT42",
          "correlationId": "corr_01JTELAGENT42",
          "idempotencyKey": "idem_01JTELAGENT42",
          "projectId": "phoenix",
          "conversationId": "conv_phoenix_7",
          "intentId": "intent_alice_oauth",
          "sender": {
            "ownerId": "alice",
            "agentId": "alice-agent",
            "provider": "codex"
          },
          "recipient": {
            "ownerId": "bob",
            "agentId": "bob-agent"
          },
          "operation": "relay_request_context",
          "payload": {
            "topic": "Session interface contract",
            "purpose": "Resolve a shared type conflict",
            "requestedPathRules": ["apps/server/src/session/**"],
            "persistence": "conversation"
          },
          "delivery": {
            "mode": "async",
            "exchangeNumber": 1,
            "createdAt": "2026-08-28T04:00:00.000Z",
            "expiresAt": "2026-08-28T04:15:00.000Z"
          },
          "evidence": {
            "branch": "alice/oauth",
            "baseCommit": "7dedb3a",
            "sourceRefs": []
          }
        },
        "mediaType": "application/vnd.telagent.request+json"
      }
    ],
    "extensions": ["urn:telagent:extension:coordination:v1"]
  },
  "configuration": {
    "acceptedOutputModes": ["application/vnd.telagent.result+json"],
    "historyLength": 0,
    "returnImmediately": true
  }
}
```

Adapter invariants:

- Require `A2A-Version: 1.0`; never rely on absence, because A2A treats a missing version as legacy v0.3.
- Require the extension in both the negotiated header and `message.extensions` if Telagent semantics are mandatory.
- Require exactly one Telagent request `data` Part for this extension version.
- Enforce `message.messageId === data.requestId` and `message.contextId === data.conversationId`.
- For a new task, reject a client-invented `message.taskId`. For continuation, resolve it and verify context/project/owner scope.
- Explicitly send `returnImmediately: true`; the default/blocking prose is inconsistent enough that relying on omission is risky.
- Authenticate first, then require the envelope's sender IDs to match the authenticated AgentBinding; overwrite/derive `provider` from that binding.

A2A requires `A2A-Version` on each client request and uses `A2A-Extensions` for extension opt-in. [A2A service parameters](https://a2a-protocol.org/latest/specification/#326-service-parameters)

## Internal async response versus A2A response

Keep the two response contracts separate.

### Telagent MVP endpoint

```http
HTTP/1.1 202 Accepted
Location: /api/operations/op_01JTELAGENT42
Retry-After: 2
Content-Type: application/json
```

```json
{
  "operationId": "op_01JTELAGENT42",
  "requestId": "req_01JTELAGENT42",
  "correlationId": "corr_01JTELAGENT42",
  "status": "accepted",
  "statusUrl": "/api/operations/op_01JTELAGENT42",
  "expiresAt": "2026-08-28T04:15:00.000Z"
}
```

RFC 9110 says a 202 response is noncommittal and ought to describe current status and point to a status monitor, but HTTP does not define Telagent's polling lifecycle. Make `statusUrl` the internal contract. Document `Location` and `Retry-After` as Telagent conventions, including whether the interval is a minimum poll delay. [RFC 9110, 202 Accepted](https://www.rfc-editor.org/rfc/rfc9110.html#name-202-accepted)

### A2A adapter

An A2A `SendMessage` response contains exactly one `Task` or one direct `Message`. Because Telagent work is asynchronous and stateful, normally return an in-progress Task when `returnImmediately` is true, and expose later updates through Get Task polling first. Add SSE or push only after the relevant Agent Card capability is implemented. [A2A SendMessage response and configuration](https://raw.githubusercontent.com/a2aproject/A2A/v1.0.1/specification/a2a.proto#L136-L177)

Map Telagent states deliberately:

| Telagent Operation status | A2A Task state | Note |
|---|---|---|
| `accepted`, `queued` | `TASK_STATE_SUBMITTED` | Accepted but not executing |
| `running` | `TASK_STATE_WORKING` | Active execution |
| `waiting_for_recipient`, `input_required` | `TASK_STATE_INPUT_REQUIRED` | Include a safe explanatory Message |
| `completed` | `TASK_STATE_COMPLETED` | Put deliverables in Artifacts |
| `failed`, `expired` | `TASK_STATE_FAILED` | Preserve Telagent error code in typed extension data |
| `cancelled` | `TASK_STATE_CANCELED` | Note A2A spelling |
| policy rejection | `TASK_STATE_REJECTED` | Not the same as authentication failure |

Do **not** map normal human approval to `TASK_STATE_AUTH_REQUIRED`. A2A defines that state for acquiring authorization credentials and explicitly does not make the state transition itself authorization. Telagent's permission classes and approvals remain separate deterministic records. [A2A in-task authorization scope](https://a2a-protocol.org/latest/specification/#764-in-task-authorization-scope)

Use Messages for requests, clarification, progress, and input prompts. Use Artifacts—or persisted Telagent records mapped to Artifacts—for ContextPacks, resolution proposals, activated agreements, plan revisions, and completion evidence. A2A warns that Messages are not guaranteed to be persisted and recommends Artifacts for task outputs. [A2A Messages and Artifacts](https://a2a-protocol.org/latest/specification/#37-messages-and-artifacts)

## Idempotency contract to freeze

A2A only says Send Message **may** be idempotent and that `messageId` may help detect duplicates; it does not standardize replay windows or responses. [A2A idempotency](https://a2a-protocol.org/latest/specification/#331-idempotency)

Freeze stronger Telagent behavior:

1. Scope a key by `(projectId, authenticatedSenderAgentId, operation, idempotencyKey)`.
2. Canonicalize the validated request fields that affect execution and store a SHA-256 fingerprint. Exclude tracing-only fields such as `correlationId`. Freeze [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html), or an explicitly equivalent stable serializer, so JSON member order and whitespace cannot change the fingerprint.
3. First request atomically creates the idempotency record and Operation.
4. Same key + same fingerprint returns the original Operation and never re-executes.
5. Same key + different fingerprint returns `409 INVALID_STATE` with a safe subcode such as `IDEMPOTENCY_KEY_REUSED`.
6. A concurrent duplicate returns the already-created Operation in its current state.
7. Retain the idempotency record at least through request expiry plus the maximum retry window; freeze the exact duration as a constant.

These details are Telagent policy. They are informed by the IETF Idempotency-Key draft, but that draft expired on 2026-04-18 and must not be presented as an Internet Standard. [Expired Idempotency-Key draft-07](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-07)

## Validation and security rules

At minimum, the Zod layer and route/service boundary should enforce:

- exact `schemaVersion: "telagent.v1"` and, at the adapter, `A2A-Version: 1.0`;
- bounded safe IDs, strings, arrays, JSON depth, Part count, and body size;
- RFC 3339 UTC timestamps with `expiresAt > createdAt`, a small accepted clock-skew window, and a server maximum TTL;
- `exchangeNumber` is exactly `1 | 2 | 3`;
- `recipient` is present for cross-agent operations;
- reply fields inherit project, conversation, recipient, schema version, and expiry constraints from the original request;
- relative path grammar only at schema level, followed by Hien's canonical filesystem containment check;
- strict operation/payload matching and rejection of unknown security-sensitive keys;
- no caller fields for permission class, approval result, ownership result, safe scope, conflict score, or task status;
- project, agent, owner, Task, and Operation lookups scoped before revealing existence;
- no credentials, `.env` content, hidden reasoning, private transcripts, raw provider stderr, or stack traces in request/result/audit payloads.

The starter currently sets Fastify's body limit to 1 MiB and parses route bodies with plain `z.object(...)`. With the installed Zod v4, unknown keys are stripped by default. The Telagent schemas should use `.strict()` so an injected property such as `permissionClass` is rejected, and the new routes should set a smaller explicit body limit that matches the frozen ContextPack/request bounds. See `apps/server/src/app.ts` for the current baseline.

This follows the A2A requirement to authenticate and authorize each operation and to prevent unauthorized resource-existence disclosure. It also aligns with OWASP guidance that model guardrails do not replace input validation, least privilege, downstream authorization, or human approval for consequential actions. [A2A security considerations](https://a2a-protocol.org/latest/specification/#13-security-considerations), [OWASP AI Agent Security](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html), [OWASP Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)

## Error boundary

Keep `duy.md`'s safe Telagent envelope for internal routes. It should include `code`, safe `message`, `correlationId`, and optional `auditEventId`, with no raw stack or provider stderr.

An A2A adapter must translate that error to the chosen binding rather than leaking the internal shape. In A2A v1 HTTP+JSON, use the normative `google.rpc.Status`-style response with typed details; in JSON-RPC, use JSON-RPC plus A2A error codes. Some current examples still show legacy `application/problem+json`, but the v1.0.1 release and normative error section supersede them. [A2A binding error mappings](https://a2a-protocol.org/latest/specification/#54-error-code-mappings), [A2A HTTP+JSON errors](https://a2a-protocol.org/latest/specification/#116-error-handling)

Suggested translation principles:

| Telagent error | A2A/HTTP behavior |
|---|---|
| `INVALID_REQUEST` | HTTP 400 with validation details that expose no secrets |
| `NOT_FOUND`, unauthorized resource | Indistinguishable safe not-found behavior |
| `POLICY_DENIED` | HTTP 403 only when disclosure is safe; otherwise not-found behavior |
| `INVALID_STATE`, `STALE_VERSION`, idempotency reuse | HTTP 400 or binding-appropriate typed application error; preserve Telagent subcode in extension details |
| `RUNTIME_UNAVAILABLE` | HTTP 500-class binding error; safe retry hint only if retry is valid |

Do not force every internal HTTP status one-to-one into A2A; preserve the semantic code in typed extension details and follow the selected binding's normative mapping.

## Required tests before implementation expands

Add these to Duy's existing edge-case list:

### Contract and mapping

- valid request parses and round-trips through the Telagent domain type;
- all 11 `operation` values accept only their matching payload;
- A2A adapter accepts one correctly typed `data` Part;
- duplicate/missing Telagent Part and unsupported extension version fail;
- `messageId/requestId` and `contextId/conversationId` mismatches fail;
- new request with invented `taskId` fails; valid continuation resolves stored Task and context;
- missing `A2A-Version` is rejected instead of silently downgrading to v0.3;
- v0.3 `kind`, lowercase roles/states, or old method names fail at the v1 adapter.

### Trust and permissions

- body sender differs from authenticated AgentBinding -> deny;
- caller-supplied `provider` is overwritten or rejected, never trusted;
- caller-supplied `permissionClass`, approval, score, or state key fails strict parsing;
- cross-project Task/Operation ID is indistinguishable from missing;
- A2A `AUTH_REQUIRED` cannot activate a Telagent approval;
- repository/prompt text cannot change routing, permission, or schema behavior.

### Time and replay

- `expiresAt <= createdAt`, stale request, excessive clock skew, and TTL above maximum fail;
- same idempotency key + same fingerprint returns the same Operation;
- same key + different fingerprint fails without execution;
- concurrent duplicate creates one Operation;
- expired idempotency records follow the frozen retention rule;
- `correlationId` change alone does not change the fingerprint.

### Response lifecycle

- accepted Telagent request returns 202 with a usable `statusUrl`;
- A2A `returnImmediately: true` returns an in-progress Task;
- terminal output maps to Artifact, while clarification maps to Message;
- every Telagent state maps to the intended A2A state;
- terminal states reject further transitions.

## Implementation order for your workstream

1. Freeze the ID grammar, timestamp/TTL/skew constants, idempotency scope, fingerprint fields, and provisional extension URI.
2. Define `PayloadByOperation`, the 11 strict payload schemas, and the `TelagentEnvelopeV1` discriminated union.
3. Define normalized authenticated principal and adapter input types so identity trust is explicit.
4. Implement pure validators for envelope invariants, expiry, reply inheritance, and state transitions.
5. Implement atomic idempotency registration against the store interface.
6. Add the internal 202 Operation DTO and safe error envelope.
7. Hand fixtures and generated/copied DTOs to Khoa, Hien, Phuong, and Thai.
8. Treat the A2A HTTP+JSON route as a later adapter; do not block the MVP engines on it.

## Open decisions to freeze with the team

- the stable Telagent extension URI and where its schema will be published;
- exact ID grammar and whether IDs are UUID/ULID or bounded opaque strings;
- maximum request TTL, clock skew, and idempotency retention window;
- whether sender-claim mismatch is `INVALID_REQUEST`, `POLICY_DENIED`, or safe not-found behavior;
- the canonical JSON/fingerprint algorithm and fields excluded from it;
- whether a duplicate in-flight request returns 202 with the original Operation or 409;
- which Telagent error details are safe to expose through an external A2A adapter;
- polling interval, Task retention, and whether interrupted A2A streams close or remain resumable.

## Sources

Primary sources used:

- [A2A v1.0.1 normative protobuf](https://raw.githubusercontent.com/a2aproject/A2A/v1.0.1/specification/a2a.proto)
- [A2A Protocol specification](https://a2a-protocol.org/latest/specification/)
- [What's new in A2A v1.0](https://a2a-protocol.org/latest/whats-new-v1/)
- [A2A v1.0.1 release notes](https://github.com/a2aproject/A2A/releases/tag/v1.0.1)
- [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
- [RFC 3339: Date and Time on the Internet](https://www.rfc-editor.org/rfc/rfc3339)
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)
- [IETF Idempotency-Key draft-07](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-07) — informative, expired draft
- [OWASP AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)
- [OWASP LLM Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)

## Bottom line

The most useful definition is not “Telagent equals A2A.” It is: **Telagent owns a strict domain request; A2A owns an optional interoperable transport envelope.** Freeze the internal schema and trust rules now, then add a thin A2A v1 adapter without allowing A2A metadata, model output, or caller claims to bypass Telagent's deterministic permission and state engines.
