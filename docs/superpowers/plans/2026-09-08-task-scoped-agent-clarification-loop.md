# Task-scoped agent clarification loop

Status: approved for implementation. The rollout remains default-off until the
implementation and release gates in this plan pass.

Date: 2026-09-08

Baseline: `main` at `b863612` after pulling the latest remote `main` on
2026-09-08. The open pull request was not inspected. Pre-existing local
modifications were preserved by Git autostash and reapplied without a conflict.

## 1. Decision summary

Build a **bounded, task-scoped clarification loop**, not an open-ended chat
between agents.

The ordinary automatic clarification exchange is:

1. the recipient-side agent returns one narrowly scoped question;
2. the originating participant's dedicated dialogue agent answers only from
   content already authorized for this task; and
3. the recipient-side agent resumes the same task and uses that answer.

An answering dialogue agent may itself discover one missing intent fact and
return a counter-question instead of an answer. That does not create a new task
or let the model select another conversation. The backend keeps the original
question pending, links the counter-question as its child in a bounded pending
clarification chain, and routes the next dialogue turn to the other
participant. The newest unresolved question must be answered before returning
to its parent. At most two clarification questions may be created in total,
including counter-questions, so the chain can never be deeper than two.

The initial release allows at most **two automatic clarification questions**,
including counter-questions. After the task's initial recipient run, every
additional provider job on either participant's machine consumes one of the
collaboration task's existing five follow-up rounds. Resource delivery,
question routing, answer routing, and the final recipient continuation all use
that same counter. Therefore an existing resource-only task retains its current
five-round ceiling and the new feature cannot create an unbounded provider
loop.

Automatic clarification is allowed only when both humans explicitly delegated
it for this exact task and the answer is derivable from already approved shared
context. It may not use a new file, a new repository fact, another private
provider session, a credential, a path outside the project, or any newly
broadened authority. When one of those is needed, the loop pauses for a human.

The final response remains a private draft. It still crosses the trust boundary
only after its owner reviews it and presses **Send**.

Saved provider sessions are an execution optimization, not the authority or the
source of truth. Session identifiers remain local to the connector. The durable
Telaegent task and approved conversation define the context and budget.

### 1.1 Terms used consistently in this plan

- **Conversation:** the durable, project-scoped, human-approved conversation
  between two people. This is Telaegent's authoritative shared memory.
- **Task:** one bounded unit of work opened from one approved shared message.
  A new originating message means a new task even inside the same conversation.
- **Private work lane:** the responder's repository-aware agent work used to
  investigate and prepare the final private draft.
- **Clarification dialogue lane:** a no-tools, approved-context-only agent lane
  used by either participant for automatic questions and answers.
- **Pending clarification chain:** at most two causally linked unresolved
  questions. This is backend terminology and never UI copy.
- **Provider session:** one local Codex/Claude working cache for exactly one
  task, participant, lane, provider, and model. It is not product memory.
- **Provider job:** one local CLI invocation. The initial private-work job is
  free; every later provider job spends one of the five follow-up rounds.

## 2. Product-policy gate that must happen before code

The current canonical rule says every cross-user message crosses only after the
owning human presses Send. An automatic clarification question and answer are
cross-user data, even if they are not added to the shared conversation.

The feature therefore requires an explicit, narrow policy amendment before it
can be enabled:

- The sender's initial Send may include a task-scoped `DialogueGrant` permitting
  that participant's dialogue agent to answer intent-only clarification
  questions from already approved context.
- The recipient explicitly enables the same grant when starting the private
  answer. This permits their agent to ask those narrowly bounded questions.
- The grant expires with the collaboration task, is revocable by either human,
  is tied to the originating shared message, and cannot be reused by another
  message, draft, conversation, repository, collaborator, or provider session.
- Clarification traffic is task-control traffic, not durable shared conversation
  memory. It is visible as a private activity trace to both owners, but it does
  not appear as an approved shared message and must not be included in later
  unrelated tasks.
- The final substantive reply still requires per-message human approval and
  Send.

If this policy amendment is not accepted, implement only a human-approved
clarification workflow: the agent may prepare a question, but the owner must
press Send for that question and for each response. Do not silently interpret a
generic "answer with agent" click as permission for autonomous cross-user
speech.

Required documentation changes are limited to the canonical plan, high-level
behavior, product flow, architecture overview, security model, and Phuong/Khoa
owner briefs. Land and review those changes before enabling the runtime path.

## 3. Protected production invariants

These are release blockers, not preferences:

1. The existing sender draft, recipient answer, edit, reject, retry, cancel, and
   exact Send paths behave byte-for-byte as they do now when the feature flag is
   off.
2. `tlg connect`, browser device authorization, OS credential-vault storage,
   repository proof, periodic repository revalidation, presence, and long
   polling are not refactored as part of the clarification feature.
3. Provider readiness probes always use `sessionMode: "fresh"`. They must never
   create, resume, rotate, or delete a task/conversation provider session. This
   is the existing regression guard for the stale-probe-session bug that made a
   healthy CLI appear unavailable.
4. Provider session IDs, CLI credentials, local repository paths, raw stderr,
   and unapproved file contents never enter a cloud job, database record,
   browser response, audit event, or shared message.
5. Every provider execution is local, read-only, network-disabled, explicitly
   authorized immediately before dispatch, and re-authorized after waiting in
   any queue.
6. A provider job completes and releases the connector binding before the cloud
   waits on the other participant, a human, or another job. The loop must not
   hold one long-poll job open while trying to dispatch a second job; doing so
   would deadlock the current one-job-per-binding relay.
7. Retries are idempotent and consume existing budgets. A disconnect, server
   restart, browser refresh, duplicate result, or stale provider session must
   never reset the two-clarification or five-follow-up limits.
8. A missing or old connector stays compatible. It continues using the current
   one-turn behavior and is never sent a job purpose or schema version it did
   not advertise.

## 4. Exact scope of automatic answering

### 4.1 Allowed without another human decision

Either participant's clarification dialogue agent may:

- restate or disambiguate the originating approved message;
- select between options already named in approved shared history;
- supply a fact already explicitly disclosed in an approved shared message for
  this project conversation;
- correct a misunderstanding using those same approved bytes; and
- say that the approved context does not contain the answer.

Its input is a server-built `ApprovedContextCapsule`, containing only:

- the originating shared message;
- the bounded approved shared-history slice selected by the existing memory
  policy;
- task-control question/answer bytes already authorized by both DialogueGrants
  in this same active task;
- stable safe facts: task ID, conversation ID, GitHub repository ID, participant
  IDs/display names, provider, task expiry, and remaining counters; and
- the explicit DialogueGrant projection.

Every clarification dialogue job has `toolMode: "none"`. It gets no
investigation pass, no delivered resources, no local file reads, no private
work-session transcript, and no conversation-wide private provider transcript.

### 4.2 Must pause for a human

The loop stops and creates an owner-visible decision whenever an answer would
require any of the following:

- a fact not already present in approved shared context, including "which
  feature are you working on?" when the feature was never disclosed;
- reading, searching, or summarizing a file, even in the same repository;
- resolving a resource hint to an opaque resource ID;
- approving a capability, widening a path, changing once-to-task duration, or
  renewing an expired/revoked grant;
- using private CLI-session memory, private drafts, another task, another
  conversation, or another collaborator's state;
- credentials, secrets, environment variables, absolute paths, filesystem
  layout, or cross-project information;
- writes, shell/network access, Git changes, or an external side effect;
- changing provider/model/effort after the task starts;
- interpreting a contradiction whose resolution represents a product or owner
  decision rather than a factual clarification; or
- any question or answer rejected by deterministic content and policy guards.

The model may recommend `human_required`; it may never declare that a grant is
sufficient. The backend computes that from task records and the exact input
capsule.

## 5. State machine

Use one server-owned state machine. Do not implement recursive calls between
agents or let a provider decide whether to launch another provider. The model
may propose an answer or counter-question; the backend validates the proposal,
tracks which participant is expected next, and selects the session.

States:

- `work_running`: the recipient's private repository-aware turn is executing.
- `work_result_ready`: recipient produced a normal answer candidate.
- `question_proposed`: work or dialogue produced a structured peer question.
- `question_rejected`: deterministic guard rejected automatic routing.
- `dialogue_turn_running`: one participant's constrained no-tools dialogue turn
  is executing.
- `dialogue_answer_ready`: a dialogue answer passed deterministic guards.
- `counter_question_proposed`: the expected answerer cannot answer without one
  more allowed intent clarification from the other participant.
- `human_required`: authority, information, policy, or safety requires a human.
- `work_resuming`: the clarification chain is resolved and the recipient's
  private work session is being rerun with the authorized answers.
- `resource_waiting`: existing capability approval path is waiting for a human.
- `runtime_failed`: a normalized runtime/transport failure ended the attempt.
- `cancelled`: either owner cancelled or authorization was revoked.
- `ready_for_owner`: the recipient has a candidate for owner review.
- `completed`: owner sent or deliberately closed the task.

Allowed transitions:

```text
work_running
  -> work_result_ready -> ready_for_owner
  -> question_proposed
       -> question_rejected -> human_required
       -> human_required
       -> dialogue_turn_running
            -> human_required
            -> runtime_failed
            -> counter_question_proposed -> dialogue_turn_running
            -> dialogue_answer_ready
                 -> another question remains -> dialogue_turn_running
                 -> chain resolved -> work_resuming -> work_running
  -> resource_waiting -> work_resuming -> work_running
  -> runtime_failed
  -> cancelled
```

Terminal/owner-controlled transitions:

- `ready_for_owner -> completed` only through current exact Send.
- `human_required -> recipient_running` only after the relevant human supplies
  the missing information or approves the exact new capability through the
  existing UI/RPC path.
- Any active state may become `cancelled` after revocation/cancel.
- A task at expiry becomes `runtime_failed` or `cancelled`; it never auto-opens
  a replacement task.

Every transition is compare-and-swap on `(task_id, expected_state,
expected_step_id)`. Duplicate connector results return the already-recorded
outcome. Out-of-order results are ignored and audited structurally.

## 6. Budgets and no-progress rules

- `maxAutomaticClarificationQuestions = 2`.
- No task may create more than two clarification questions in
  total. The second may be a follow-up or a counter-question. Answers do not
  replenish that budget.
- Maximum unresolved clarification-chain depth is two. A child
  counter-question must be resolved before its parent.
- Maximum automatic cross-agent control messages is four: two questions and
  two answers. A fifth proposed message stops for a human.
- Keep the existing durable `follow_up_rounds <= 5`. After the initial
  recipient job, spend one before every additional provider job on either side,
  whether caused by resource delivery, a question, an answer, or a
  counter-question.
- Maximum peer question length: 500 UTF-8 bytes.
- Maximum clarification answer: 1,500 UTF-8 bytes.
- Maximum in-flight clarification transcript: 4,000 UTF-8 bytes.
- Maximum task lifetime remains the existing 60 minutes.
- One active clarification step per task; one active provider job per binding.
- One automatic recovery from `RUNTIME_SESSION_NOT_FOUND` per job, already
  performed locally by the session manager. It does not create another task
  step or refresh a budget.
- No automatic retry for `RUNTIME_AUTH_FAILED`, `RUNTIME_UNAVAILABLE`, policy
  failure, invalid output, or an unknown error.
- An exact normalized repeat, an empty answer, a missing/invalid parent link,
  or an unchanged recipient result is deterministic no progress. Stop at
  `human_required` on the first detected repetition rather than spending all
  remaining rounds. Treat broader semantic evasiveness as a protocol-evaluation
  criterion, not as authorization logic the backend can prove perfectly.

Normalize question and answer bytes before hashing: Unicode NFC, trim outer
whitespace, normalize CRLF to LF, and preserve case. Store only bounded hashes
and structural metadata durably; never use an LLM-generated identifier as an
idempotency key.

## 7. Wire contracts

Introduce protocol version/capability negotiation before adding behavior.

### 7.1 Connector capability advertisement

Readiness/presence gains an additive capabilities list, for example:

```json
{
  "protocolVersion": 2,
  "capabilities": ["task_sessions_v1", "peer_clarification_v1"]
}
```

Old connectors omit it and remain fully usable for existing jobs. The cloud
dispatches clarification jobs only when the selected binding advertises both
capabilities. Capability absence is not reported as provider unavailability;
the UI says the connector needs an update or falls back to human clarification.

### 7.2 Job envelope

Add only safe identifiers:

- `taskId`;
- `taskLane`: `private_work` or `clarification_dialogue`;
- `participantRole`: `requester` or `responder`, derived from the task rather
  than accepted as routing authority;
- `stepId`, generated by the server;
- `protocolVersion`;
- the existing user/repository/conversation/provider/correlation fields.

Do not add a provider session ID, local path, grant contents, bearer, or a
client-selected peer/binding ID. The connector derives the local session key
from the authorized job.

### 7.3 Recipient output

Keep the current strict schema unchanged for version 1. Add a version-2 schema
with an optional, mutually exclusive peer request:

```text
peerClarification = {
  question,
  reasonCode: ambiguity | contradiction | missing_intent,
  sharedBasisMessageIds[]
}
```

Rules:

- It is allowed only with `state = needs_clarification` and a null
  `sendCandidate`.
- It cannot coexist with resource requests. Access/resource needs go through
  the existing capability path and human approval.
- `sharedBasisMessageIds` must all belong to the server-selected approved
  context capsule. They are evidence hints, never authorization.
- The question passes existing secret/path/cross-project/injection guards plus a
  purpose-built intent-question guard.
- If auto-routing is unavailable, preserve current `needs_clarification`
  behavior and show the recipient owner the question privately.

Do not repurpose the existing `needs_clarification` UI state to mean "waiting
for the other agent." The durable draft continues to use it for local-owner
clarification; loop progress is separate server-owned activity.

### 7.4 Clarification dialogue output

Create one separate strict schema used by either participant while in the
no-tools dialogue lane:

```text
{
  outcome: answered | counter_question | human_required,
  privateExplanation,
  answer: string | null,
  counterQuestion: object | null,
  sharedBasisMessageIds[],
  riskFlags[]
}
```

It has no `sendCandidate`, resource request, source path, referenced path, or
tool request field. `answered` requires a non-empty answer and only approved
basis IDs. `counter_question` requires a null answer, one bounded question, an
unresolved parent-question ID supplied by the backend, and remaining question
budget. `human_required` requires a null answer and a safe explanation for that
agent's owner.

## 8. Provider session architecture

### 8.1 Scope

Replace conversation-wide task execution scope with a connector-local key:

```text
connector installation
+ user ID
+ GitHub repository ID
+ conversation ID
+ collaboration task ID
+ peer user ID
+ task lane
+ provider
+ selected model
```

The responder's repository-aware initial turn and final continuation use one
`private_work` task session. Each participant gets a separate
`clarification_dialogue` session containing only the approved context capsule
and task-control chain. A dialogue turn must never resume `private_work`, even
on the same participant's machine, because the work session may contain private
repository findings. No lane can resume an ordinary sender-draft session or a
different task.

Session selection is deterministic:

| Situation | Session action |
| --- | --- |
| First local turn for this task + participant + lane + provider/model | Start fresh, store returned exact ID in memory |
| Same active task and same local participant/lane/provider/model speaks again | Resume that lane's exact in-memory ID |
| Direction flips to the other participant | Route to that person's connector; resume their dialogue session if it exists, otherwise start it fresh |
| Agent asks a counter-question | Keep the same task; link one child question; route to the other side's dialogue lane |
| New human-approved originating message | Open a new task and start new task sessions, even in the same project conversation |
| Different repository, conversation, peer, task role, or provider | Start a new session; never search for a similar old one |
| Connector restarted or in-memory ID is absent | Start fresh and rehydrate from approved task/conversation context |
| Exact provider session reports not found | Delete that one pointer, start fresh once, and rehydrate |
| Task expired/cancelled/completed | Invalidate both sides' task sessions; never resume them |
| Authority/resource is revoked after a model saw it | Invalidate the affected task session and rehydrate without the revoked material before any further turn |

Example:

```text
Human A sends message M1 -> task T1
B works on reply            -> new local session B/T1/private-work
B asks Q1                   -> route to A
A handles Q1                -> new local session A/T1/dialogue
A asks counter-question Q2  -> route to B
B answers Q2                -> new local session B/T1/dialogue
A answers pending Q1        -> resume A/T1/dialogue
B prepares final reply      -> resume B/T1/private-work
```

No provider session ID crosses between A and B. "Resume" always means resume an
exact ID held by the connector on the machine now executing. The stable shared
conversation remains the product memory; T1 merely isolates this one chain of
work inside it.

### 8.2 Local in-memory session index

Keep `InMemoryProviderSessionStore` for the first release. It is not product
memory; it is a short-lived map from the task scope above to the exact opaque
Codex/Claude session ID. The provider's own session holds a private working
cache, while the approved Telaegent conversation and durable task remain the
only authoritative memory.

The map is needed while `tlg connect` is alive. Without it, the connector would
not know which exact provider session to resume and would have to rehydrate a
fresh session on every turn. Requirements:

- session IDs remain in the connector process and never cross to the cloud;
- scope includes task, participant, and lane, so dialogue cannot resume a
  repository-aware work session or any conversation-wide private session;
- validate every scope and provider-returned session ID;
- invalidate on task completion/cancel, repository or collaborator revocation,
  credential rotation, provider removal, and explicit disconnect;
- bound entries by active tasks and prune expired tasks; and
- losing the map on connector restart intentionally falls back to one fresh,
  fully rehydrated task session. It must not mark the provider or connector
  unavailable.

Do not add a disk-backed session registry or put session IDs in the OS
credential vault for the first release. Real-provider tests on 2026-09-08
confirmed both required paths: exact-ID resume survives individual Codex/Claude
CLI process exits, and a lost/invalid pointer can recover through one fresh turn
hydrated solely from approved context. Disk persistence would therefore improve
restart latency only; it is not needed for correctness and carries stale/private
context risk. Reconsider it later only with measured latency evidence and a
separate threat-model review.

### 8.3 Resume and recovery

- Use exact provider IDs: `codex exec resume <id>` and Claude `--resume <id>`.
- Never use Codex/Claude "last" or "continue most recent" behavior.
- A first task turn starts fresh with the complete approved context capsule.
- A continuation resumes the exact task session and supplies only the new
  bounded event plus current task counters and authority projection.
- If the CLI returns `RUNTIME_SESSION_NOT_FOUND`, delete only that exact local
  mapping and retry once with a freshly hydrated full task context.
- Auth, binary-not-found, spawn, timeout, unsupported policy, and transport
  errors do not trigger fresh-session fallback.
- A recovered session must produce the same schema version and remain in the
  same task scope. Recovery never resets counters or authority.

## 9. Cloud orchestration and authorization

Open/resolve the collaboration task before an opted-in recipient's first run,
instead of waiting until the first resource request. Scope continues to be
derived by the database from the originating approved shared message.

Add an authorization service that resolves each task participant's current
connector binding from durable task/project/conversation membership. Callers
may supply the task and expected role, but never the destination binding or a
different user. Re-check:

- task is active and unexpired;
- task originated from the exact shared message being answered;
- repository ID, conversation, requester, and responder still match;
- project connection and collaborator relationship remain active;
- both required DialogueGrant sides remain active;
- target connector credential, repository proof, and presence are current;
- selected provider/model/effort remain supported; and
- current step and budgets permit the requested transition.

Perform this check when preparing the job and immediately before execution
after any relay queue wait. Revocation cancels or prevents the next job and
ends at `human_required`/`cancelled`; it never falls back to another binding.

The orchestration sequence is iterative and server-controlled:

1. Run the recipient job and await its bounded result.
2. Persist only safe status/counters/hashes; release its connector job.
3. If ready/blocked/local-owner clarification, settle through the current path.
4. If resources are requested, run the unchanged capability approval/delivery
   path, atomically spend a continuation round, then rerun recipient.
5. If a peer question is proposed, validate both DialogueGrants, budgets,
   capability advertisement, no-progress, and deterministic guards; atomically
   reserve the next step and spend its follow-up round.
6. Dispatch a separate no-tools clarification-dialogue job to the expected
   participant; release it on result.
7. If it asks an allowed counter-question, link it as the child of the current
   unresolved question, atomically reserve/spend the next step, and route to the
   other side's dialogue lane.
8. If it answers, resolve the exact newest pending question. If its parent still
   needs an answer, atomically reserve/spend the next step and resume that
   participant's dialogue lane. If no question remains, atomically
   reserve/spend the next step and resume the original recipient's private-work
   lane toward the final draft.
9. If it needs a human or fails a policy check, expose the decision to the
   correct owner and stop automatic execution.
10. Settle the recipient draft when the chain is empty and the recipient
    produces a candidate. Never branch the chain or accept an answer that does
    not reference the newest unresolved question.

Always store task state, counters, participant/lane routing, timestamps, parent
step IDs, bounded content hashes, normalized reason/failure codes, and step IDs
durably. Store no provider session ID, local path, resource bytes, credential,
or model reasoning.

Exact clarification question/answer text is retained in a separate,
task-private payload store only until the task completes, is cancelled, or
reaches its existing 60-minute expiry. It is then deleted, leaving only safe
structural metadata and bounded content hashes. The payload never becomes
long-term shared conversation memory. Important facts must be restated in the
final reply and become durable only when its owner presses Send.

## 10. “Runtime unavailable” hardening

Do not use one internal cause for all availability failures. Preserve the safe
public `RUNTIME_UNAVAILABLE` contract where needed, but record a bounded local
or server-only structural reason:

- connector absent;
- connector presence stale;
- binding busy;
- provider capability not advertised;
- provider readiness probe failed;
- provider executable missing/spawn failed;
- provider authentication failed;
- exact session missing;
- connector-cloud transport interrupted;
- repository proof/revalidation failed;
- runtime binding rotated or revoked; or
- job lease/result timeout.

Hardening work before enabling the loop:

1. Add a composition test proving production server wiring uses
   `LongPollConnectorJobRelay` and authorized connector execution, never
   `ConnectorUnavailableDraftRuntime`.
2. Preserve the regression test that readiness probes always use fresh sessions
   and add a test that a probe cannot touch the in-memory task-session map.
3. Treat authenticated long polling as authoritative presence. A transient
   readiness-refresh failure must not take down an already healthy connector.
4. Keep connector polling failures distinct from provider failures in local
   logs and metrics.
5. Check connector/version/provider readiness before accepting an automatic
   step, then re-check at dispatch to handle time-of-check/time-of-use changes.
6. Release the binding between steps. "Waiting for peer" is a cloud task state,
   never a running connector job.
7. On connector restart, restore browser-authorized identity from the OS vault,
   restore ready binding as the current code does, re-probe providers with fresh
   sessions, and rehydrate the next task turn from approved context. Do not try
   to rediscover or guess a previous provider session.
8. Map `RUNTIME_SESSION_NOT_FOUND` to local one-time recovery, not connector
   unavailability. A successful fresh recovery should be invisible except for a
   privacy-safe metric.
9. Never blindly retry a job whose result may have reached the cloud. Use the
   server `stepId` and connector `jobId` to deduplicate completion.
10. Add UI guidance that distinguishes "connector offline," "provider login
    required," "connector update required," and safe generic turn failure,
    without exposing stderr or local paths.

## 11. Persistence and migrations

Use additive, reversible migrations only:

- add task-scoped dialogue grant flags/version, grantors, grant timestamps, and
  revocation timestamps;
- add `automatic_clarification_questions` with a database check from 0 to 2;
- add task orchestration state/version, current expected participant/lane, and
  last step ID/hash fields for compare-and-swap and crash reconciliation;
- add parent-linked clarification step metadata containing IDs, direction,
  kind, status, sequence, timestamps, and bounded content hash but no provider
  session/private reasoning;
- reuse `follow_up_rounds` for every provider job after the initial recipient
  job, regardless of which participant runs it, so the existing five-round
  bound remains authoritative;
- add RPCs that derive project/conversation/repository/participants from task
  and message records; and
- deny direct client mutation. Only service-role orchestration or narrowly
  authorized owner grant/revoke RPCs may change these fields.

Store question/answer payload separately with task-participant-only reads, an
expiry no later than the task's existing 60-minute expiry, deletion on
completion/cancel/expiry, bounded length, and no promotion to
`shared_messages`. Restart reconciliation may use that short-lived payload only
to resume the same authorized task and must still revalidate grants, budgets,
connector readiness, and authority before dispatch.

No migration renames/drops existing states, tables, constraints, RPC arguments,
or columns in the rollout. Old server/connector code must continue to operate
during a rolling deployment. Test RLS/service-role behavior and revoke default
execution grants on every new function.

## 12. UI behavior

Add the feature behind a default-off flag and capability check.

### 12.1 Grant controls

- On the original sender approval surface, show an optional unchecked control:
  "Allow agents to clarify this message automatically (maximum 2 questions)."
- Explain directly below it: "Only information already shared here may be used.
  New files, permissions, or private context still require a person."
- When the recipient chooses Answer with agent, show the matching unchecked
  control before starting the run.
- The loop starts only when both controls were accepted for this exact task. If
  either side declines, preserve the current private-draft workflow.
- Either participant can revoke with "Stop agent clarification." Revocation
  prevents the next dispatch and invalidates both dialogue sessions.

### 12.2 Main conversation

Do not render clarification traffic as ordinary shared-message bubbles. Show
one compact task-status card beneath the originating message:

```text
Agents clarifying this request · Question 1 of 2
Waiting for Alice's agent                         [View] [Stop]
```

The card is not a spinner-only state. It always names the current safe status
and offers View; the participant with authority to stop also gets Stop. Screen
readers receive status changes through a polite live region.

### 12.3 Clarification activity panel

View opens a chronological panel called "Agent clarification." Do not expose
the backend term "chain" and do not visually render a stack. Show only the
cross-user question/answer text authorized by the bilateral DialogueGrant:

```text
Bob's agent asked
"Which feature is this reconnect behavior for?"

Alice's agent asked a follow-up
"Do you mean OAuth or provider-session recovery?"

Bob's agent answered
"Provider-session recovery."

Alice's agent is answering the original question...

Questions used: 2 of 2                            [Stop and take over]
```

- A counter-question is labelled "asked a follow-up," with a small "In reply
  to the previous question" caption. Chronological order is sufficient.
- Never show model reasoning, private explanations, local paths, session IDs,
  resource contents, raw stderr, or guard internals.
- A model's private explanation is visible only to its owning human in their
  private room.
- The task card and panel disappear or collapse when the task ends according to
  the task ends and its short-lived payload is deleted. Important conclusions
  must be restated in the final human-approved reply so durable memory never
  depends on this panel.

### 12.4 Human-required states

The human who must act sees an actionable private panel:

```text
Your input is needed
Your agent cannot answer this from information already shared.

"Which private branch contains that implementation?"

[Answer privately] [Stop]
```

If the blocker is resource authority, route to the existing exact-resource
approval UI and show Review access request / Deny. Never turn a natural-language
answer into a capability grant.

The other participant sees only "Waiting for Alice — human input is required."
They do not learn whether a file was missing, access was denied, a secret was
detected, or the owner chose not to answer.

After the human answers, automatic execution resumes only if that human
explicitly presses Continue and the bilateral grant, task, budgets, connector,
and provider are still valid. Otherwise the task stays paused.

### 12.5 Completion, retry, and compatibility

- When the clarification chain resolves, return to the recipient's existing
  private draft surface.
- Ready still means the unchanged Edit / No / Send gate. Only Send creates the
  durable shared reply.
- Retry reuses the same task and spent counters. The current retry path that
  creates a new private draft must resolve the same task from the originating
  message rather than regain budget.
- Browser refresh reloads safe task status and, if the chosen retention model
  permits it, the task-control transcript. It never guesses from provider
  sessions.
- An old connector gets "Connector update required for agent clarification" or
  the human workflow. Capability absence is never labelled runtime unavailable.
- Offline/provider failures identify the safe action: reconnect connector,
  sign into provider, retry the turn, or take over manually. Never leave an
  indefinite disabled state.

## 13. Implementation sequence and rollback boundary

Each phase should be a reviewable change that can ship with the flag off.

### Phase 0 — establish baseline

- Install dependencies from the pulled lockfile without modifying it.
- Run `npm run check` and record failures before touching behavior.
- Run the current real `tlg connect --probe-only`/doctor flow for Codex and
  Claude on the development machine.
- Capture current connector availability and draft latency/failure counters.
- Add characterization tests for current sender, recipient, resource follow-up,
  retry, cancellation, and exact Send behavior.

Exit: a green or explicitly understood baseline. Do not code the loop on top of
an unexplained runtime-connectivity failure.

### Phase 1 — policy, contracts, and flags

- Amend canonical/security documents after product approval.
- Define DialogueGrant, protocol v2 schemas, task role, state machine, counters,
  and safe errors as pure types/tests.
- Add server and web feature flags, default off in every environment.
- Add connector capability advertisement; old behavior remains the default.

Rollback: disable the flag; no runtime behavior changes.

### Phase 2 — runtime-unavailable regression shield

- Add composition, readiness-probe isolation, reconnect, stale presence,
  provider-auth, and binding-busy characterization tests.
- Add safe structural reason metrics and UI mappings.
- Do not change device authorization or the probe algorithm beyond isolated
  tests/fixes demonstrated by a failing regression.

Exit: all current runtime-connectivity tests pass before session work begins.

### Phase 3 — task-scoped local sessions

- Extend session scope and connector job envelope additively.
- Retain the connector CLI's `InMemoryProviderSessionStore`, but key it by the
  new task/participant/lane scope and add expiry/revocation cleanup.
- Prove that `clarification_dialogue` cannot resume or read the
  repository-aware `private_work` session on the same machine.
- Implement full approved-context hydration for missing sessions.
- Keep ordinary v1 jobs on their current scope/path until v2 is enabled.

Rollback: turn off task sessions and let the process-local entries expire; cloud
records contain no provider IDs and there is no disk migration to undo.

### Phase 4 — durable budget/authorization primitives

- Add additive migration/RPCs for bilateral grant, two-round counter, unified
  continuation spending, revocation, and compare-and-swap step metadata.
- Implement repository and authorization adapters with fake-contract tests.
- Deploy migration before server code that calls it.

Rollback: flag off; additive fields/functions remain inert.

### Phase 5 — orchestration with fake runtimes

- Implement the iterative clarification coordinator outside the relay.
- Add no-progress detection, cancellation, crash reconciliation, and normalized
  failure handling.
- Integrate resource and clarification continuations under the same five-round
  task-wide provider-job budget.
- Prove no connector binding remains claimed between steps.

Exit: deterministic two-agent integration suite passes without real CLIs.

### Phase 6 — connector/provider integration

- Add the version-2 recipient schema/prompt and the shared clarification-dialogue
  schema/prompt.
- Add the `clarification_dialogue` purpose through trusted allowlists only.
- Enforce no investigation, tools, resources, or private-work transcript for
  clarification dialogue on either side.
- Exercise exact Codex and Claude resume IDs and one-time missing-session
  recovery.

Exit: local real-provider matrix passes with flag enabled only for test users.

### Phase 7 — UI and owner controls

- Add bilateral opt-in, activity state, stop/revoke, human-required actions, and
  old-connector guidance.
- Preserve existing private draft and Send components as the final gate.
- Add accessibility, refresh/reopen, stale-tab, duplicate-click, and mobile
  tests.

### Phase 8 — staged release

1. Deploy migrations.
2. Deploy flag-off cloud/server/web.
3. Publish the connector package and verify its exact installed artifact.
4. Upgrade one internal connector; v1 connectors remain supported.
5. Enable for an internal project and one provider.
6. Run the two-machine acceptance matrix.
7. Expand to both providers, then a small percentage of projects.
8. Compare runtime availability, failure, cancellation, latency, and duplicate
   rates to baseline.
9. Roll back by disabling the server flag on any regression; connector v2 must
   continue processing v1 jobs.

Do not delete v1 schemas/paths or make the feature default-on in this project.
That is a later release after production evidence.

## 14. Test plan

### Unit tests

- every allowed and forbidden state transition;
- two-question cap and existing five-continuation cap, including concurrent
  spend and retries;
- bilateral grant issue, revoke, expiry, wrong task/message/peer/repository;
- context digest and same-context predicate;
- strict v1/v2 output parsing and cross-version rejection;
- peer question cannot coexist with resource asks;
- answer basis IDs must be in approved context;
- secret, credential, absolute path, cross-project, prompt-injection, oversized,
  empty, duplicate, and no-progress output;
- in-memory session-map expiry, invalidation, bounded size, and scope isolation;
- strict isolation between each participant's `private_work` and
  `clarification_dialogue` sessions;
- connector restart loses the map and performs exactly one approved-context
  hydration rather than reporting runtime unavailable;
- exact session resume arguments; never `--last`/implicit continue;
- deterministic new-versus-resume decisions for first turn, direction changes,
  counter-questions, new originating messages, role/provider changes, restart,
  revocation, expiry, and missing sessions;
- one-time session-not-found recovery and no recovery for auth/unavailable;
- readiness probes stay fresh and never read/write task sessions;
- safe failure normalization never exposes stderr, prompt, path, or session ID.

### Cloud/database contract tests

- task scope is derived from originating shared message;
- a browser/client cannot choose another user or connector binding;
- old tasks and old clients continue to work;
- RPC grants are revoked from public/anon/authenticated where appropriate;
- compare-and-swap rejects duplicate and out-of-order results;
- counters survive new draft retries and server restarts;
- revocation between prepare and dispatch prevents execution;
- expiry closes grants and prevents resume;
- safe metadata/hashes are always persisted; no resource bytes, provider session
  ID, local path, credential, or reasoning appears in rows/audits;
- if short-lived payload retention is selected, question/answer text exists only
  in the dedicated participant-restricted TTL store and is deleted on every
  terminal path; if zero retention is selected, no row contains that text.

### Connector/relay integration tests

- recipient A -> sender B -> recipient A happy path;
- recipient B asks Q1, sender A asks counter-question Q2, B answers Q2, A
  answers Q1, and B resumes to produce the final draft;
- a counter-question with an invalid parent, missing approved basis, or exact
  normalized repetition is rejected as no progress;
- the protocol corpus scores unrelated/evasive counter-questions as failures;
- a third question, branch, answer to a non-top question, and repeated Q1/Q2
  stop for a human;
- two clarification questions, their answers, and the final work continuation;
- a third question stops for a human;
- resource delivery followed by clarification and vice versa;
- binding is released before dispatching to the other connector;
- one participant offline before and during each step;
- binding busy, stale presence, provider unavailable, provider logged out;
- connector restart between question and answer and between answer and resume;
- stale Codex/Claude session recovers once from durable approved context;
- cloud restart mid-loop recovers from the TTL payload when that option is
  selected, or fails safely when zero retention is selected; both preserve
  spent budgets and never reconstruct text from hashes;
- duplicate poll/result, lost HTTP response, delayed result, cancellation race,
  revocation race, and task expiry;
- connector polling network failure is not classified as provider unavailable;
- resource requests are still prioritized and served during an active local
  provider turn without being swallowed.

### Real-provider acceptance matrix

Run on two independently authenticated machines/checkouts:

- Codex -> Codex;
- Claude -> Claude;
- Codex dialogue -> Claude dialogue/work continuation;
- Claude dialogue -> Codex dialogue/work continuation;
- connector restart on each side;
- provider logout/re-login;
- cloud deploy/restart between steps;
- repository access revoked mid-loop;
- collaborator connection revoked mid-loop; and
- old connector on one side.

For each case verify: correct local working directory, no writes, no network,
exact provider session resume, no session IDs/cloud paths in traffic, bounded
rounds, correct owner action, and final Send remains required.

### Full regression gate

- `npm run typecheck`
- targeted server protocol/session/connector/relay/conversation tests
- Supabase authorization contract tests and migration smoke test
- web unit/component tests
- `npm run build`
- full `npm run check`
- packaged connector install test, not only source execution
- signed-in browser plus two-machine end-to-end proof

No phase is accepted based only on mocked providers. No production claim is
made until the packaged connector, deployed migrations, cloud server, browser,
and two real local CLIs pass together.

## 15. Observability and release gates

Emit only bounded structural events:

- task/step correlation hashes, never content;
- state transition and duration;
- provider and connector protocol version;
- remaining clarification/follow-up counts;
- normalized runtime code and structural availability reason;
- session outcome: fresh, exact resume, recovered from missing, or hydration;
- cancellation/revocation/expiry; and
- duplicate/out-of-order suppression.

Never emit question/answer text, prompt, shared-message body, resource bytes,
session ID, local path, CLI command line, raw stderr, or credential.

Release gates:

- zero known authorization/scope leaks;
- zero regressions in v1 sender/recipient/Send flows;
- zero probe-created continuation sessions;
- zero unbounded/restarted budgets;
- no meaningful increase in connector false-unavailable rate versus Phase 0;
- all failure states end with a visible owner action, not an indefinite spinner;
- rollback verified in staging by disabling the flag during an active loop; and
- two-machine real-provider matrix green.

## 16. Files expected to change

Exact names may adjust during implementation, but ownership should stay
localized:

- canonical/product/security/owner docs for the policy amendment;
- `apps/server/src/provider-session-manager.ts` for task/participant/lane scope, bounded
  in-memory cleanup, and approved-context recovery;
- `apps/server/src/connectors/cli.ts`, `connector-worker.ts`,
  `connector-turn-executor.ts`, readiness/capability schemas, and focused tests;
- `apps/server/src/runtime-contract.ts` and runtime allowlists;
- `apps/server/src/telagent/protocol/contract.ts`, schemas, guards, prompts,
  runtime adapter, corpus, and protocol tests;
- a new task clarification coordinator under conversations/capability rather
  than recursive logic in the relay;
- collaboration task/authorization repositories and additive Supabase
  migrations/RPC tests;
- conversation service/repository types only where needed to expose safe loop
  progress and retain task identity on retry;
- web API/view types and `ProductApp.tsx` for explicit grants and progress; and
- end-to-end connector conversation tests.

Avoid broad rewrites of `tlg connect`, device authorization, long-poll relay,
the current resource broker, or the final Send transaction. Changes in those
areas require a failing characterization test proving they are necessary.

## 17. Definition of done

The feature is done only when:

1. both humans explicitly opt into a task-bound two-question grant;
2. a recipient work agent can ask a safe intent clarification and either
   participant's dialogue agent can answer from approved context without human
   interruption;
3. either agent deterministically escalates when new knowledge or authority is
   needed;
4. the recipient resumes the exact task context and produces a private draft;
5. the final answer still requires owner edit/reject/Send;
6. provider sessions resume by exact ID across CLI process exits while the
   connector is alive, and connector restart safely rehydrates a fresh session
   from approved conversation context;
7. all counters, revocations, retries, and scope checks survive races/restarts;
8. old connectors and flag-off production behave exactly as before;
9. the runtime-unavailable regression suite and two-machine provider matrix are
   green; and
10. disabling the feature flag immediately restores the current production
    path without a rollback migration.

## 18. Explicit non-goals

- autonomous negotiation or open-ended agent chat;
- automatic file/resource approval;
- write/execute/network authority;
- cloud-hosted provider execution or cloud-stored provider credentials/sessions;
- sharing private provider transcripts as durable memory;
- cross-project or cross-repository context;
- changing the five-round resource safety ceiling;
- replacing human final-message approval; or
- removing the existing v1 path during this rollout.

## 19. Planning-time baseline check

Immediately after pulling `main`, the targeted provider-session, connector
worker, two-pass worker, relay, conversation-pipeline, and follow-up-turn tests
ran successfully: 86 tests passed across six suites. The connector routes suite
and TypeScript server check could not load because the newly pulled
`@fastify/rate-limit` dependency is not present in the existing local
`node_modules`. No dependency installation was performed during planning, so
the lockfile and the user's worktree were not changed for that purpose.

Phase 0 must begin by installing the exact pulled lockfile dependencies, then
rerunning the full baseline. Treat a remaining failure after installation as a
pre-existing release blocker; do not attribute it to or mask it with agent-loop
work.

Two real-provider assumptions were also tested on 2026-09-08:

- Codex: one `codex exec` process created a session and exited; a new
  `codex exec resume <exact-id>` process recovered a nonce that was not repeated
  in the second prompt.
- Claude: one `claude -p` process created a session and exited; a new
  `claude -p --resume <exact-id>` process recovered its unrepeated nonce.
- The repository recovery proof was run separately against Codex and Claude
  with a deliberately invalid stored session ID. Both classified the missing
  session, started fresh once, injected only a synthetic approved conversation,
  and returned the expected fact (`teal`).

This evidence supports an in-memory exact-session pointer during connector
uptime plus approved-context rehydration after connector restart. It does not
justify a disk-backed Telaegent session index.

## 20. Locked product decisions

The product owner approved all three recommended defaults on 2026-09-08. These
are implementation constraints, not remaining questions.

### Q1. How long should automatic clarification text remain available?

Decision: keep question/answer payload in a separate, task-private,
short-lived store until the task completes or reaches its existing 60-minute
expiry, then delete it. Keep only safe structural metadata/hashes afterward.
This makes browser refresh and a cloud process restart recoverable without
turning clarification into durable conversation memory.

### Q2. Where should humans opt in?

Decision: bilateral, per-task consent. The original sender enables it while
pressing Send; the recipient enables it before Answer with agent. Both controls
default off. This is the narrowest defensible exception to the current rule
that every cross-user message requires Send.

### Q3. What happens after a human supplies missing context?

Decision: the loop stays paused after the human types an answer and resumes
only when that human presses Continue. It reuses the same task, remaining two-
question/five-follow-up budgets, and current authority snapshot.
