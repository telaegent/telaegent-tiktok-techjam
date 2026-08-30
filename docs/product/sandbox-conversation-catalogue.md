# Sandbox Conversation Catalogue

**Status:** Landing-page demo fixture, not a backend authorization or product-policy contract.

This catalogue records every repository-scoped conversation used by the eight-person sandbox and every person-to-person relationship, including relationships that are not currently eligible because the people do not share a repository.

## Repository membership

| Repository | People |
| --- | --- |
| `telaegent/message-gateway` | Tom, Eugene, Laura, Ash, Ed |
| `telaegent/project-console` | Laura, Ash, Ed, Gareth |
| `telaegent/runtime-control` | Gareth, Norman, Tung |

The repository is always the first scope boundary. Two people can talk only inside a repository they both connected. Laura, Ash, and Ed have separate conversations in two repositories because repository context and durable memory never cross automatically.

## Option behavior

Every option is deterministic for the sandbox:

```text
person selects question X
        ->
their private agent returns answer Y
        ->
the person still chooses Send or Decline
```

The answer remains private until the owning human chooses Send.

## `telaegent/message-gateway`

### Tom and Eugene: Webhook delivery contract

Shared context: The gateway records an immutable delivery ID before enqueueing a webhook.

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Tom | Ask whether the worker can accept `deliveryId`. | Check compatibility | The worker ignores unknown fields, so the field can ship additively on the current event version. |
| Tom | Ask whether the worker can accept `deliveryId`. | Agree on timing | Worker support can merge by 3 PM after replay tests pass; the old payload remains valid until then. |
| Eugene | Ask which timeout the gateway uses before retrying delivery. | Configured timeout | The gateway waits 8 seconds for a worker acknowledgement. |
| Eugene | Ask which timeout the gateway uses before retrying delivery. | Full retry schedule | Attempts run after 8 seconds, 30 seconds, and 2 minutes; only network and 5xx failures retry. |

### Tom and Laura: Message schema migration

Shared context: Laura added optional `approvalActor` metadata to project messages.

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Tom | Ask whether `approvalActor` can become required. | Check existing rows | Older messages have no value; backfill from audit events before adding a non-null constraint. |
| Tom | Ask whether `approvalActor` can become required. | Request staged plan | Deploy read support, run the backfill, then enforce the constraint in a later release. |
| Laura | Ask which gateway release writes the field. | Release tag | The write is scheduled for gateway v0.8.3 after the schema migration. |
| Laura | Ask which gateway release writes the field. | Exact commit | Commit `6d2c41a` introduces the write and awaits compatibility review. |

### Tom and Ash: Client retry behavior

Shared context: The client retains a pending message until the gateway confirms its durable ID.

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Tom | Ask how duplicate acknowledgements behave after reconnect. | Visible behavior | The existing pending row updates; no second message renders. |
| Tom | Ask how duplicate acknowledgements behave after reconnect. | Deduplication key | The client reconciles with `clientRequestId` until it receives the durable message ID. |
| Ash | Ask which message-creation failures retry. | Normalized codes | `RUNTIME_UNAVAILABLE` and `PROVIDER_TIMEOUT` retry; policy and scope failures do not. |
| Ash | Ask which message-creation failures retry. | Transport conditions | Connection loss and upstream 5xx responses retry before a normalized safe failure returns. |

### Tom and Ed: Approval audit fixtures

Shared context: Contract tests prove that every shared message has a human approval event.

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Tom | Ask whether edited drafts are covered. | Check coverage | Send and decline are covered; edited candidates are not yet covered. |
| Tom | Ask whether edited drafts are covered. | Add edit case | The new case will prove the shared body matches the edited candidate, not the private draft. |
| Ed | Ask for the canonical approval event order. | Public events only | `message.approved`, `message.persisted`, then `message.broadcast`. |
| Ed | Ask for the canonical approval event order. | Include private boundary | Private events stay user-scoped; approval creates a separate shared message event. |

### Eugene and Laura: Event schema compatibility

Shared context: The worker and project schema currently share event version 4.

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Eugene | Ask whether version 5 can keep the version 4 envelope. | Compare fields | Version 5 adds `approvalActor` and `repositoryId` without changing envelope keys. |
| Eugene | Ask whether version 5 can keep the version 4 envelope. | Compatibility guarantee | Version 4 consumers receive additive reads for the next two releases. |
| Laura | Ask whether replay preserves unknown fields. | Decode behavior | Known fields decode while the original payload remains intact for forwarding and audit. |
| Laura | Ask whether replay preserves unknown fields. | Dead-letter payload | The full original JSON, event version, and delivery ID are stored. |

### Eugene and Ash: Reconnect acknowledgement

Shared context: Reconnect can receive acknowledgements created while the browser was offline.

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Eugene | Ask whether acknowledgements can arrive out of order. | One conversation | The client buffers by conversation sequence until preceding items arrive. |
| Eugene | Ask whether acknowledgements can arrive out of order. | Whole project | Project-wide order is not imposed; conversations advance independently. |
| Ash | Ask which identifier acknowledges a replayed event. | Delivery identifier | Acknowledge `deliveryId`; retry metadata changes but delivery identity stays stable. |
| Ash | Ask which identifier acknowledges a replayed event. | Message identifier | Use `messageId` for UI reconciliation, never for delivery acknowledgement. |

### Eugene and Ed: Webhook replay tests

Shared context: The suite injects a timeout after persistence and before acknowledgement.

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Eugene | Ask whether replay remains idempotent. | Assertion list | One message, one audit event, and two attempts with the same delivery ID. |
| Eugene | Ask whether replay remains idempotent. | Remaining failure | Add a case where acknowledgement is lost after collaborator notification succeeds. |
| Ed | Ask how invalid replay payloads fail. | Safe UI error | Return `EVENT_PAYLOAD_INVALID`, safe text, and `retryable: false`. |
| Ed | Ask how invalid replay payloads fail. | Worker handling | Move the event to dead letter and record version without logging content. |

### Laura and Ash: Nullable approval actor

Shared context: Legacy messages can be read before `approvalActor` backfill finishes.

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Laura | Ask how legacy messages should label approval. | Hide metadata | Omit the approval line while preserving the shared author. |
| Laura | Ask how legacy messages should label approval. | Show unavailable | Put a historical-record notice in details, not the main chat row. |
| Ash | Ask when all messages have an approver. | Migration milestone | Backfill finishes after gateway v0.8.3 and before the constraint migration. |
| Ash | Ask when all messages have an approver. | New-message guarantee | Every message after v0.8.3 includes the field at write time. |

### Laura and Ed: Schema test coverage

Shared context: The schema suite reads legacy and current durable conversation rows.

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Laura | Ask for the approval migration fixture matrix. | Supported shapes | Cover legacy null, backfilled human ID, and new writes with a required human ID. |
| Laura | Ask for the approval migration fixture matrix. | Test files | Use `message-schema.compat.test.ts` and `approval-backfill.contract.test.ts`. |
| Ed | Ask which invariants must hold after backfill. | Identity invariant | `approvalActor` references the human who approved the exact shared candidate. |
| Ed | Ask which invariants must hold after backfill. | Repository invariant | Approver, conversation, and message resolve to one stable repository ID. |

### Ash and Ed: Retry UI contract tests

Shared context: Retry controls render only when the normalized failure permits retry.

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Ash | Ask whether policy-blocked sends are covered. | Visible copy | Show a safe explanation and no internal matcher details. |
| Ash | Ask whether policy-blocked sends are covered. | Allowed actions | Permit Edit and Discard; omit Send and Retry. |
| Ed | Ask what appears during a safe retry. | Status text | Show `Retrying with your Codex` and retain the last safe error in details. |
| Ed | Ask what appears during a safe retry. | Interaction lock | Disable Retry during the attempt while Edit and Discard remain available. |

## `telaegent/project-console`

### Laura and Ash: Repository picker states

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Laura | Ask whether the picker can consume unavailable reasons. | Empty state | Show the safe reason and a reconnect GitHub action when no repository is usable. |
| Laura | Ask whether the picker can consume unavailable reasons. | Repository row | Keep the repository visible but disabled with the server-provided next action. |
| Ash | Ask which repository states are stable. | Availability only | `ready`, `syncing`, `unavailable`, and `access_revoked`. |
| Ash | Ask which repository states are stable. | Full lifecycle | Also include `authorization_required` and `clone_failed` with safe recovery actions. |

### Laura and Ed: Provider status contract

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Laura | Ask whether reconnect fixtures cover non-retryable failures. | Fixture coverage | Cover auth expired, runtime unavailable, timeout, and policy blocked. |
| Laura | Ask whether reconnect fixtures cover non-retryable failures. | Normalized shape | Include code, safe error, retryable, status, and allowed actions. |
| Ed | Ask which progress states the UI preserves. | User-visible states | `not_connected`, `connecting`, `connected`, `reconnect_required`, `unavailable`. |
| Ed | Ask which progress states the UI preserves. | Internal steps | Keep provisioning private and expose safe progress plus allowed actions only. |

### Laura and Gareth: Console release cutover

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Laura | Ask whether console deployment can precede runtime migration. | Compatibility window | Retain the adapter for one release while runtimes migrate. |
| Laura | Ask whether console deployment can precede runtime migration. | Hard cutover | Wait for runtime reconnect and timeout contract suites to pass. |
| Gareth | Ask which screen should be smoke tested. | Provider connection | Test `reconnect_required` through `connected` and clear safe progress text. |
| Gareth | Ask which screen should be smoke tested. | Private retry | Retry a timeout once and preserve the draft and allowed actions. |

### Ash and Ed: Failure rendering fixtures

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Ash | Ask for retryable and non-retryable fixtures. | Provider failures | Runtime unavailable retries; authentication revoked offers reconnect only. |
| Ash | Ask for retryable and non-retryable fixtures. | Preparation failures | Provider timeout retries; protected content permits edit or discard only. |
| Ed | Ask whether failure rendering preserves drafts. | Retryable failure | Keep the draft visible and editable while retry uses the same private session. |
| Ed | Ask whether failure rendering preserves drafts. | Policy block | Hide the unsafe candidate but retain the rough intent for a safe rewrite. |

### Ash and Gareth: Frontend environment setup

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Ash | Ask for required environment-variable names without values. | Browser-safe names | `VITE_API_BASE_URL` and `VITE_SUPABASE_URL`; no service-role key belongs in the browser. |
| Ash | Ask for required environment-variable names without values. | Server runtime names | `SUPABASE_SERVICE_ROLE_KEY` and `RUNTIME_CONTROL_URL`; share names and docs only. |
| Gareth | Ask how missing public endpoint configuration fails. | Build-time validation | Production builds stop with a safe missing-variable error. |
| Gareth | Ask how missing public endpoint configuration fails. | Runtime fallback | Development can explicitly use localhost; production has no fallback. |

### Ed and Gareth: Release contract gate

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Ed | Ask which suite blocks release. | Failing suite | Runtime reconnect is the only blocker. |
| Ed | Ask which suite blocks release. | Assertion and owner | `retryable` is missing on `PROVIDER_AUTH_EXPIRED`; Gareth owns the adapter fix. |
| Gareth | Ask what proves the old adapter can be removed. | Automated gates | All normalized failures and progress transitions pass in console and server. |
| Gareth | Ask what proves the old adapter can be removed. | Manual checklist | Reconnect, retry timeout, preserve draft, and verify no Retry on a hard block. |

## `telaegent/runtime-control`

### Gareth and Norman: Safe runtime telemetry

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Gareth | Ask whether metrics separate reconnect from retry. | Metric labels | Use operation, provider, safe code, and duration buckets. |
| Gareth | Ask whether metrics separate reconnect from retry. | Release query | Compare success and p95 by operation without user, repo name, or content. |
| Norman | Ask which runtime states emit progress. | External contract | `queued`, `starting`, `authenticating`, `running`, `waiting_for_approval`, `completed`, `failed`. |
| Norman | Ask which runtime states emit progress. | Internal transitions | Container allocation and CLI process detail stay internal. |

### Gareth and Tung: Container rollout isolation

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Gareth | Ask whether one user's repositories reuse a workspace. | Filesystem reuse | No. Every user and repository pair gets a separate workspace and runtime scope. |
| Gareth | Ask whether one user's repositories reuse a workspace. | Credential reuse | Provider identity belongs to one user, but storage mounts only in that repository scope. |
| Tung | Ask which health probe runs before a provider turn. | Readiness probe | Check workspace scope, provider CLI, and control-plane heartbeat. |
| Tung | Ask which health probe runs before a provider turn. | Release qualification | Also prove resume, isolation, normalized failure output, and revocation cleanup. |

### Norman and Tung: Failure telemetry boundary

| Perspective | Request | Option | Pre-coded answer |
| --- | --- | --- | --- |
| Norman | Ask whether timeout telemetry includes raw stderr. | Privacy guarantee | Raw stderr remains inside the isolated diagnostic boundary. |
| Norman | Ask whether timeout telemetry includes raw stderr. | Safe fields | Record normalized code, retryable, provider, operation, duration bucket, and runtime revision. |
| Tung | Ask how to correlate a failed turn without message content. | Inside one runtime | Use an ephemeral turn correlation ID and rotate it after completion. |
| Tung | Ask how to correlate a failed turn without message content. | Across control plane | Use a restricted opaque audit event linked to user ID and stable repository ID. |

## Every person-to-person relationship

This table covers all 28 unique pairs. A relationship marked unavailable has a future conversation purpose written down, but Telaegent must not enable it until both people independently prove access to one shared repository.

| Pair | Current shared repository | Conversation purpose |
| --- | --- | --- |
| Tom and Eugene | message-gateway | Webhook delivery contract |
| Tom and Laura | message-gateway | Message schema migration |
| Tom and Ash | message-gateway | Client retry behavior |
| Tom and Ed | message-gateway | Approval audit fixtures |
| Tom and Gareth | Unavailable | Gateway to runtime release boundary |
| Tom and Norman | Unavailable | Delivery telemetry contract |
| Tom and Tung | Unavailable | Gateway container readiness |
| Eugene and Laura | message-gateway | Event schema compatibility |
| Eugene and Ash | message-gateway | Reconnect acknowledgement |
| Eugene and Ed | message-gateway | Webhook replay tests |
| Eugene and Gareth | Unavailable | Worker rollout coordination |
| Eugene and Norman | Unavailable | Webhook delivery telemetry |
| Eugene and Tung | Unavailable | Worker container configuration |
| Laura and Ash | message-gateway, project-console | Schema fallback and repository picker behavior |
| Laura and Ed | message-gateway, project-console | Schema and provider contract coverage |
| Laura and Gareth | project-console | Console release cutover |
| Laura and Norman | Unavailable | Schema-safe telemetry fields |
| Laura and Tung | Unavailable | Runtime scope schema |
| Ash and Ed | message-gateway, project-console | Retry UI and failure rendering contracts |
| Ash and Gareth | project-console | Safe frontend environment setup |
| Ash and Norman | Unavailable | User-visible telemetry states |
| Ash and Tung | Unavailable | Runner failure UX |
| Ed and Gareth | project-console | Release contract gate |
| Ed and Norman | Unavailable | Telemetry contract fixtures |
| Ed and Tung | Unavailable | Isolation contract tests |
| Gareth and Norman | runtime-control | Safe runtime telemetry |
| Gareth and Tung | runtime-control | Container rollout isolation |
| Norman and Tung | runtime-control | Failure telemetry boundary |

## Coverage totals

- 8 people
- 3 repository scopes
- 19 repository-scoped pair conversations
- 38 directional private-agent question paths
- 76 deterministic option-to-answer mappings
- 28 unique person-to-person relationships documented
- 12 relationships intentionally unavailable until a shared repository exists
