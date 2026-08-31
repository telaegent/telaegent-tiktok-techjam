export type SandboxPersonId =
  | "tom"
  | "eugene"
  | "laura"
  | "ash"
  | "ed"
  | "gareth"
  | "norman"
  | "tung";

export type SandboxPerson = {
  id: SandboxPersonId;
  name: string;
  initial: string;
  provider: "Claude Code" | "Codex";
  branch: string;
};

export type SandboxOption = {
  label: string;
  answer: string;
};

export type SandboxSide = {
  intent: string;
  agentQuestion: string;
  note: string;
  options: SandboxOption[];
};

export type SandboxConversation = {
  id: string;
  people: [SandboxPersonId, SandboxPersonId];
  topic: string;
  sharedContext: string;
  sides: Record<SandboxPersonId, SandboxSide>;
};

export type SandboxRepository = {
  id: string;
  name: string;
  shortName: string;
  defaultViewer: SandboxPersonId;
  members: SandboxPersonId[];
  conversations: SandboxConversation[];
};

export const peopleById: Record<SandboxPersonId, SandboxPerson> = {
  tom: { id: "tom", name: "Tom", initial: "T", provider: "Codex", branch: "feat/gateway-contract" },
  eugene: { id: "eugene", name: "Eugene", initial: "E", provider: "Claude Code", branch: "feat/webhook-worker" },
  laura: { id: "laura", name: "Laura", initial: "L", provider: "Codex", branch: "feat/project-schema" },
  ash: { id: "ash", name: "Ash", initial: "A", provider: "Claude Code", branch: "feat/client-sync" },
  ed: { id: "ed", name: "Ed", initial: "E", provider: "Codex", branch: "test/message-contract" },
  gareth: { id: "gareth", name: "Gareth", initial: "G", provider: "Claude Code", branch: "feat/runtime-release" },
  norman: { id: "norman", name: "Norman", initial: "N", provider: "Codex", branch: "feat/runtime-telemetry" },
  tung: { id: "tung", name: "Tung", initial: "T", provider: "Claude Code", branch: "feat/container-runner" },
};

function side(
  intent: string,
  agentQuestion: string,
  note: string,
  options: SandboxOption[],
): SandboxSide {
  return { intent, agentQuestion, note, options };
}

function conversation(
  id: string,
  first: SandboxPersonId,
  second: SandboxPersonId,
  topic: string,
  sharedContext: string,
  firstSide: SandboxSide,
  secondSide: SandboxSide,
): SandboxConversation {
  return {
    id,
    people: [first, second],
    topic,
    sharedContext,
    sides: { [first]: firstSide, [second]: secondSide } as Record<SandboxPersonId, SandboxSide>,
  };
}

export const sandboxRepositories: SandboxRepository[] = [
  {
    id: "message-gateway",
    name: "telaegent/message-gateway",
    shortName: "message-gateway",
    defaultViewer: "tom",
    members: ["tom", "eugene", "laura", "ash", "ed"],
    conversations: [
      conversation(
        "gateway-tom-eugene",
        "tom",
        "eugene",
        "Webhook delivery contract",
        "The gateway now records an immutable delivery ID before enqueueing a webhook.",
        side(
          "Ask Eugene whether the webhook worker can accept the new deliveryId field this afternoon.",
          "Should I ask for a compatibility check or a firm migration time?",
          "The field is additive, but Eugene owns the consumer and must confirm the rollout.",
          [
            { label: "Check compatibility", answer: "Eugene's worker ignores unknown fields, so deliveryId can ship additively. Keep the current event version for this release." },
            { label: "Agree on timing", answer: "Eugene can merge worker support by 3 PM after the replay test passes. Tom should keep the old payload valid until then." },
          ],
        ),
        side(
          "Ask Tom what timeout the gateway uses before retrying webhook delivery.",
          "Do you need the configured timeout or the complete retry schedule?",
          "A precise scope keeps the response short and avoids exposing unrelated runtime settings.",
          [
            { label: "Configured timeout", answer: "The gateway waits 8 seconds for a worker acknowledgement before marking the attempt retryable." },
            { label: "Full retry schedule", answer: "Attempts run after 8 seconds, 30 seconds, and 2 minutes. Only network and 5xx failures are retryable." },
          ],
        ),
      ),
      conversation(
        "gateway-tom-laura",
        "tom",
        "laura",
        "Message schema migration",
        "Laura added an optional approvalActor field to the project message schema.",
        side(
          "Ask Laura whether approvalActor can be required in the next gateway release.",
          "Should I check existing rows first or ask Laura for a staged migration plan?",
          "Making the field required before backfill would break durable conversation reads.",
          [
            { label: "Check existing rows", answer: "Older messages have no approvalActor. Backfill from the audit event before adding a non-null constraint." },
            { label: "Request staged plan", answer: "Laura recommends deploy-read support, run the backfill, then enforce the constraint in a later release." },
          ],
        ),
        side(
          "Ask Tom which gateway release first writes approvalActor.",
          "Do you want the release tag or the exact commit that introduces the write path?",
          "The release tag is useful for operations; the commit is better for code review.",
          [
            { label: "Release tag", answer: "The write path is scheduled for gateway v0.8.3 after the schema migration lands." },
            { label: "Exact commit", answer: "Tom's branch introduces the write in commit 6d2c41a, currently awaiting schema compatibility review." },
          ],
        ),
      ),
      conversation(
        "gateway-tom-ash",
        "tom",
        "ash",
        "Client retry behavior",
        "Ash's client keeps a pending message local until the gateway confirms its durable ID.",
        side(
          "Ask Ash how the client handles a duplicate acknowledgement after reconnect.",
          "Should I ask about visible UI behavior or the client-side deduplication key?",
          "Both are valid, but they lead to different implementation answers.",
          [
            { label: "Visible behavior", answer: "The duplicate acknowledgement updates the existing pending row. It does not render a second message." },
            { label: "Deduplication key", answer: "The client reconciles with clientRequestId until the gateway returns the durable message ID." },
          ],
        ),
        side(
          "Ask Tom which failures the gateway marks retryable for message creation.",
          "Do you want the normalized failure codes or the underlying transport conditions?",
          "The UI should consume normalized codes, not infer policy from raw transport errors.",
          [
            { label: "Normalized codes", answer: "RUNTIME_UNAVAILABLE and PROVIDER_TIMEOUT are retryable. POLICY_BLOCKED and PROJECT_SCOPE_MISMATCH are not." },
            { label: "Transport conditions", answer: "The gateway retries connection loss and upstream 5xx responses, then returns a normalized safe failure." },
          ],
        ),
      ),
      conversation(
        "gateway-tom-ed",
        "tom",
        "ed",
        "Approval audit fixtures",
        "Ed's contract suite verifies that every shared message has a human approval event.",
        side(
          "Ask Ed whether the new gateway fixture covers edited drafts before Send.",
          "Should I request the current coverage or ask Ed to add the missing edit case?",
          "The request is safe and limited to the shared message contract.",
          [
            { label: "Check coverage", answer: "The fixture covers send and decline, but not an edited candidate. Ed has confirmed the gap." },
            { label: "Add edit case", answer: "Ed will add a case proving the shared body matches the edited candidate, not the original private draft." },
          ],
        ),
        side(
          "Ask Tom for the canonical event order when a user approves a prepared message.",
          "Do you need only the public events or the private preparation events too?",
          "Private preparation must not appear in the collaborator-visible event stream.",
          [
            { label: "Public events only", answer: "The public order is message.approved, message.persisted, then message.broadcast." },
            { label: "Include private boundary", answer: "Private draft events remain user-scoped. Approval creates a new shared message event without copying private turns." },
          ],
        ),
      ),
      conversation(
        "gateway-eugene-laura",
        "eugene",
        "laura",
        "Event schema compatibility",
        "The webhook worker and project schema currently share event version 4.",
        side(
          "Ask Laura if event version 5 can keep the version 4 message envelope.",
          "Should I compare fields or ask for a formal compatibility guarantee?",
          "A field comparison is actionable now; a guarantee requires broader backend agreement.",
          [
            { label: "Compare fields", answer: "Version 5 adds approvalActor and repositoryId without changing the version 4 envelope keys." },
            { label: "Compatibility guarantee", answer: "Laura can guarantee additive reads for version 4 consumers through the next two releases." },
          ],
        ),
        side(
          "Ask Eugene whether the worker preserves unknown event fields during replay.",
          "Do you need decode behavior or the replayed payload written to the dead-letter store?",
          "Unknown fields matter because a replay must not silently strip newer contract data.",
          [
            { label: "Decode behavior", answer: "The worker decodes known fields and retains the original payload for forwarding and audit." },
            { label: "Dead-letter payload", answer: "Dead-letter records store the full original JSON payload with its event version and delivery ID." },
          ],
        ),
      ),
      conversation(
        "gateway-eugene-ash",
        "eugene",
        "ash",
        "Reconnect acknowledgement",
        "The browser reconnect path may receive acknowledgements created while the tab was offline.",
        side(
          "Ask Ash whether the client can process webhook acknowledgements out of order.",
          "Should I ask about ordering within one conversation or across the entire project?",
          "Conversation ordering is guaranteed; project-wide ordering is not a product requirement.",
          [
            { label: "One conversation", answer: "Ash buffers by conversation sequence and applies acknowledgements only when the preceding sequence is present." },
            { label: "Whole project", answer: "The client does not impose project-wide order. Each conversation advances independently." },
          ],
        ),
        side(
          "Ask Eugene what identifier the client should use when acknowledging a replayed event.",
          "Do you need the delivery identifier or the durable message identifier?",
          "Acknowledging the wrong identifier can cause repeat delivery without duplicating the message itself.",
          [
            { label: "Delivery identifier", answer: "Acknowledge deliveryId. Each retry has its own attempt metadata but retains that stable delivery identity." },
            { label: "Message identifier", answer: "Use messageId for UI reconciliation, but never use it as the webhook delivery acknowledgement key." },
          ],
        ),
      ),
      conversation(
        "gateway-eugene-ed",
        "eugene",
        "ed",
        "Webhook replay tests",
        "The replay suite injects a timeout after persistence but before acknowledgement.",
        side(
          "Ask Ed whether the replay test proves that the handler stays idempotent.",
          "Should I ask for the assertion list or the remaining failure case?",
          "The test should prove both durable storage and side-effect safety.",
          [
            { label: "Assertion list", answer: "The suite asserts one stored message, one audit event, and two delivery attempts with the same delivery ID." },
            { label: "Remaining failure", answer: "It still needs a case where the acknowledgement is lost after the collaborator notification succeeds." },
          ],
        ),
        side(
          "Ask Eugene how the worker behaves when replay payload validation fails.",
          "Do you need the safe error returned to the UI or the worker's internal handling?",
          "Telaegent exposes safe normalized failures and keeps internal payload details private.",
          [
            { label: "Safe UI error", answer: "The UI receives EVENT_PAYLOAD_INVALID, a safe explanation, and retryable false." },
            { label: "Worker handling", answer: "The worker moves the event to the dead-letter store and records the schema version without logging message content." },
          ],
        ),
      ),
      conversation(
        "gateway-laura-ash",
        "laura",
        "ash",
        "Nullable approval actor",
        "Older messages can be read before approvalActor has been backfilled.",
        side(
          "Ask Ash how the UI should label an older message with no approvalActor.",
          "Should the UI hide the metadata or show that the historical approver is unavailable?",
          "The fallback must not invent an approver identity.",
          [
            { label: "Hide metadata", answer: "Ash recommends omitting the approval line for legacy messages while keeping the shared author visible." },
            { label: "Show unavailable", answer: "Use 'Approval record unavailable for this older message' in details, not in the main chat row." },
          ],
        ),
        side(
          "Ask Laura when approvalActor becomes non-null for every message.",
          "Do you need the migration milestone or a runtime guarantee for new messages?",
          "The two guarantees start at different points in the rollout.",
          [
            { label: "Migration milestone", answer: "The backfill completes after the v0.8.3 gateway deployment and before the constraint migration." },
            { label: "New-message guarantee", answer: "Every message created after gateway v0.8.3 includes approvalActor at write time." },
          ],
        ),
      ),
      conversation(
        "gateway-laura-ed",
        "laura",
        "ed",
        "Schema test coverage",
        "The schema suite must read both legacy and current durable conversation rows.",
        side(
          "Ask Ed to confirm the fixture matrix for approvalActor migration.",
          "Do you want the supported row shapes or the exact test files?",
          "The supported shapes are the useful contract; file paths are secondary implementation detail.",
          [
            { label: "Supported shapes", answer: "Ed covers legacy null, backfilled human ID, and new writes with a required human ID." },
            { label: "Test files", answer: "The cases live in message-schema.compat.test.ts and approval-backfill.contract.test.ts." },
          ],
        ),
        side(
          "Ask Laura which schema invariants the contract tests should enforce after backfill.",
          "Should I focus on identity, repository scope, or both?",
          "Both are security relevant and should remain server-enforced.",
          [
            { label: "Identity invariant", answer: "approvalActor must reference the human who approved the exact shared candidate." },
            { label: "Repository invariant", answer: "The approver, conversation, and message must all resolve to the same stable GitHub repository ID." },
          ],
        ),
      ),
      conversation(
        "gateway-ash-ed",
        "ash",
        "ed",
        "Retry UI contract tests",
        "The client renders retry controls only when the normalized failure says retryable true.",
        side(
          "Ask Ed whether the UI contract test covers a policy-blocked send.",
          "Should I ask for the visible copy or the allowed-action assertions?",
          "Allowed actions must come from the backend contract, not frontend inference.",
          [
            { label: "Visible copy", answer: "The test expects a safe explanation and no raw policy matcher details." },
            { label: "Allowed actions", answer: "The blocked state permits Edit and Discard. Send and Retry are absent." },
          ],
        ),
        side(
          "Ask Ash what the client shows while a safe retry is in progress.",
          "Do you need the status text or the interaction lock behavior?",
          "The user should understand whose side has the turn and avoid duplicate submissions.",
          [
            { label: "Status text", answer: "The row says 'Retrying with your Codex' and keeps the last safe error available in details." },
            { label: "Interaction lock", answer: "The retry action disables during the attempt; Edit and Discard remain available for the private draft." },
          ],
        ),
      ),
    ],
  },
  {
    id: "project-console",
    name: "telaegent/project-console",
    shortName: "project-console",
    defaultViewer: "laura",
    members: ["laura", "ash", "ed", "gareth"],
    conversations: [
      conversation(
        "console-laura-ash",
        "laura",
        "ash",
        "Repository picker states",
        "The project console now distinguishes unavailable repositories from revoked access.",
        side(
          "Ask Ash whether the repository picker can consume the new unavailable reason.",
          "Should I ask about the empty state or the per-repository row treatment?",
          "The reason is safe display text supplied by the backend.",
          [
            { label: "Empty state", answer: "When no repository is usable, Ash shows the safe reason and a reconnect GitHub action." },
            { label: "Repository row", answer: "An unavailable repository stays visible but disabled, with the server-provided next action beside it." },
          ],
        ),
        side(
          "Ask Laura which repository status values are stable for the frontend.",
          "Do you need only availability or the full authorization lifecycle?",
          "The UI should render explicit server states and never infer repository access.",
          [
            { label: "Availability only", answer: "Use ready, syncing, unavailable, and access_revoked for the picker." },
            { label: "Full lifecycle", answer: "The lifecycle also includes authorization_required and clone_failed, each with a safe recovery action." },
          ],
        ),
      ),
      conversation(
        "console-laura-ed",
        "laura",
        "ed",
        "Provider status contract",
        "The console needs stable provider progress and normalized failure shapes.",
        side(
          "Ask Ed whether the provider reconnect fixtures include retryable false failures.",
          "Should I request fixture coverage or the exact normalized shape?",
          "The stable contract is code, safe error, retryable, status, and allowed actions.",
          [
            { label: "Fixture coverage", answer: "Ed covers auth expired, runtime unavailable, timeout, and policy blocked, including both retryable values." },
            { label: "Normalized shape", answer: "Each fixture includes code, safeError, retryable, progress status, and allowedActions." },
          ],
        ),
        side(
          "Ask Laura which progress states the provider connection screen must preserve.",
          "Do you need the user-visible states or internal provisioning steps?",
          "Internal infrastructure steps should not leak into the product UI.",
          [
            { label: "User-visible states", answer: "Use not_connected, connecting, connected, reconnect_required, and unavailable." },
            { label: "Internal steps", answer: "Keep provisioning detail internal; expose only a safe progress message and current allowed action." },
          ],
        ),
      ),
      conversation(
        "console-laura-gareth",
        "laura",
        "gareth",
        "Console release cutover",
        "Gareth's release switches the console to the normalized provider contract.",
        side(
          "Ask Gareth whether the console can deploy before every runtime reports the new status shape.",
          "Should I ask for a compatibility window or a hard cutover time?",
          "Mixed contracts need an explicit rollout plan to avoid false connected states.",
          [
            { label: "Compatibility window", answer: "Gareth can keep the adapter for one release while runtimes migrate to the normalized shape." },
            { label: "Hard cutover", answer: "The hard cutover is blocked until runtime-control passes the reconnect and timeout contract suite." },
          ],
        ),
        side(
          "Ask Laura which console screen should be used for the release smoke test.",
          "Do you want the provider connection path or the private message retry path?",
          "Both use the normalized contract, but the private room exercises more allowed actions.",
          [
            { label: "Provider connection", answer: "Use reconnect_required to connected and verify the safe progress message clears." },
            { label: "Private retry", answer: "Use a retryable timeout, retry once, then confirm the prepared draft and allowed actions remain intact." },
          ],
        ),
      ),
      conversation(
        "console-ash-ed",
        "ash",
        "ed",
        "Failure rendering fixtures",
        "The shared failure component is used in provider setup and private message preparation.",
        side(
          "Ask Ed for one fixture where retry is allowed and one where it is not.",
          "Should I ask for provider failures or message preparation failures?",
          "Using both surfaces proves that the component follows allowed actions rather than route-specific logic.",
          [
            { label: "Provider failures", answer: "Use runtime unavailable as retryable and authentication revoked as reconnect only." },
            { label: "Preparation failures", answer: "Use provider timeout as retryable and protected content as edit or discard only." },
          ],
        ),
        side(
          "Ask Ash whether the failure component keeps the private draft visible.",
          "Do you need behavior for retryable failures or policy blocks?",
          "The user must not lose their private intent when the provider fails.",
          [
            { label: "Retryable failure", answer: "The draft remains visible and editable while Retry uses the same private preparation session." },
            { label: "Policy block", answer: "The unsafe candidate is not shown; the user's rough intent remains available for a safe rewrite." },
          ],
        ),
      ),
      conversation(
        "console-ash-gareth",
        "ash",
        "gareth",
        "Frontend environment setup",
        "The release environment requires public endpoint names but no secret values in chat.",
        side(
          "Ask Gareth which environment variables the console needs, without sending any values.",
          "Do you need browser-safe names or the complete server runtime list?",
          "Telaegent will not send raw environment values or credentials.",
          [
            { label: "Browser-safe names", answer: "The console uses VITE_API_BASE_URL and VITE_SUPABASE_URL. No service-role key belongs in the browser." },
            { label: "Server runtime names", answer: "The server uses SUPABASE_SERVICE_ROLE_KEY and RUNTIME_CONTROL_URL. Share names and setup docs only." },
          ],
        ),
        side(
          "Ask Ash whether the frontend build fails clearly when VITE_API_BASE_URL is absent.",
          "Do you want build-time validation or the runtime fallback behavior?",
          "A public endpoint is not a secret, but a missing value should still fail safely.",
          [
            { label: "Build-time validation", answer: "The production build now fails with a safe missing-variable message before assets are emitted." },
            { label: "Runtime fallback", answer: "Development falls back to localhost only when DEV mode is explicit. Production has no fallback." },
          ],
        ),
      ),
      conversation(
        "console-ed-gareth",
        "ed",
        "gareth",
        "Release contract gate",
        "The release pipeline runs provider, repository, and private-room contract suites.",
        side(
          "Ask Gareth which contract suite blocks the current console release.",
          "Do you need the failing suite or the exact assertion and owner?",
          "The response can identify code ownership without exposing private runtime data.",
          [
            { label: "Failing suite", answer: "The runtime reconnect suite is the only blocker; repository and private-room contracts pass." },
            { label: "Assertion and owner", answer: "retryable is missing on PROVIDER_AUTH_EXPIRED. Gareth owns the adapter fix in runtime-control." },
          ],
        ),
        side(
          "Ask Ed what evidence is required before removing the old provider adapter.",
          "Should I ask for automated gates or the manual smoke-test checklist?",
          "Removing compatibility code needs both contract proof and one browser flow check.",
          [
            { label: "Automated gates", answer: "All normalized failure fixtures and provider progress transitions must pass in console and server workspaces." },
            { label: "Manual checklist", answer: "Reconnect a provider, retry a timeout, preserve the private draft, and verify a non-retryable block has no Retry action." },
          ],
        ),
      ),
    ],
  },
  {
    id: "runtime-control",
    name: "telaegent/runtime-control",
    shortName: "runtime-control",
    defaultViewer: "gareth",
    members: ["gareth", "norman", "tung"],
    conversations: [
      conversation(
        "runtime-gareth-norman",
        "gareth",
        "norman",
        "Safe runtime telemetry",
        "Norman's telemetry records provider progress without logging prompts or responses.",
        side(
          "Ask Norman whether the new runtime metric can separate reconnect from retry.",
          "Do you need metric labels or the dashboard query used during release checks?",
          "Telemetry must not include repository content, prompts, or provider output.",
          [
            { label: "Metric labels", answer: "Use operation=reconnect or operation=retry with provider, safe code, and duration buckets." },
            { label: "Release query", answer: "Compare success rate and p95 duration by operation. Do not group by user, repository name, or message content." },
          ],
        ),
        side(
          "Ask Gareth which runtime states should emit progress events.",
          "Do you need the minimal external contract or every internal process transition?",
          "Only stable user-relevant progress belongs in the provider status contract.",
          [
            { label: "External contract", answer: "Emit queued, starting, authenticating, running, waiting_for_approval, completed, and failed." },
            { label: "Internal transitions", answer: "Container allocation and CLI process details remain internal telemetry, not frontend states." },
          ],
        ),
      ),
      conversation(
        "runtime-gareth-tung",
        "gareth",
        "tung",
        "Container rollout isolation",
        "Tung's runner update keeps the minimum isolation unit at user by repository.",
        side(
          "Ask Tung whether the new runner reuses a workspace across two repositories for one user.",
          "Should I ask about filesystem reuse or provider credential reuse?",
          "Cross-repository workspace or credential leakage is forbidden.",
          [
            { label: "Filesystem reuse", answer: "No. Each cloud binding resolves only to its user and repository mapping inside that user's local connector." },
            { label: "Credential reuse", answer: "Provider identity stays in the developer's local CLI home; Telaegent cloud never mounts or stores it." },
          ],
        ),
        side(
          "Ask Gareth which health probe the runner must pass before receiving a provider turn.",
          "Do you need the minimum readiness probe or the full release qualification?",
          "Readiness should be fast; qualification belongs in deployment tests.",
          [
            { label: "Readiness probe", answer: "Verify workspace scope, provider CLI availability, and control-plane heartbeat before accepting a turn." },
            { label: "Release qualification", answer: "Also prove session resume, repository isolation, normalized failure output, and cleanup after revocation." },
          ],
        ),
      ),
      conversation(
        "runtime-norman-tung",
        "norman",
        "tung",
        "Failure telemetry boundary",
        "The runner emits normalized safe failures before telemetry records them.",
        side(
          "Ask Tung whether timeout telemetry includes the provider's raw stderr.",
          "Do you need the privacy guarantee or the fields that replace raw stderr?",
          "Provider output and repository content must not enter shared telemetry.",
          [
            { label: "Privacy guarantee", answer: "Raw stderr stays on the local connector and is never attached to cloud product telemetry." },
            { label: "Safe fields", answer: "Telemetry records normalized code, retryable, provider, operation, duration bucket, and runtime revision." },
          ],
        ),
        side(
          "Ask Norman how to correlate a failed turn without logging private message content.",
          "Do you need correlation inside one runtime or across the control plane?",
          "Opaque identifiers can support debugging without becoming user-visible product state.",
          [
            { label: "Inside one runtime", answer: "Use an ephemeral turn correlation ID scoped to that runtime session and rotate it after completion." },
            { label: "Across control plane", answer: "Use an opaque audit event ID linked to user ID and stable repository ID under restricted access." },
          ],
        ),
      ),
    ],
  },
];

export function findSandboxConversation(
  repository: SandboxRepository,
  first: SandboxPersonId,
  second: SandboxPersonId,
) {
  return repository.conversations.find(
    (item) => item.people.includes(first) && item.people.includes(second),
  );
}
