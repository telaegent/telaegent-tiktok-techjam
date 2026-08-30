# Phuong — Backend Co-Owner, Local Connector, Claude Code/Codex Runtime, Provider Sessions, Telaegent Memory, Capability Loop, and Integration Architecture

**Status:** Architecture/research brief before implementation  
**Product:** Telaegent  
**Backend co-owner:** Khoa  
**Primary goal:** Own the execution path from Telaegent conversation → private coding-agent runtime → human-approved shared message, while making provider sessions fast but keeping Telaegent's own project memory authoritative.

---

# 1. Your scope

## 1.1 Architecture reconciliation

The local connector model is canonical. Khoa's GitHub proof and Phuong's
provider execution both happen on the developer machine; the cloud authorizes
and routes only opaque connector-bound jobs.

```text
Telaegent backend
→ connector presence/job relay
→ User × Repo opaque connector binding
→ outbound local connector
   ├─ local gh authenticated as owner
   ├─ local repo/worktree
   ├─ local Claude/Codex auth
   └─ local provider sessions
```


You currently own the broadest integration seam:

### With Khoa

- central backend architecture
- users/projects/conversations
- connection/message authorization integration
- API contracts
- state transitions
- audit
- persistence semantics

### Specifically yours

- Claude Code CLI integration
- Codex CLI integration
- provider connection/auth lifecycle
- connector/cloud job contract
- local process launching
- structured output parsing
- session creation/resume
- provider switching
- provider failure/reconnect
- Telaegent durable conversation memory
- private draft-session behavior
- shared-message orchestration
- recovery when provider session disappears
- overall integration architecture
- bounded agentic-loop integration, local policy engine, and file broker

You are not expected to personally implement every component immediately. First freeze the correct seams with Khoa/Thai/Hien/Duy.

---

# 2. Canonical runtime model

Telaegent does **not** use Claude consumer chats or the Codex app as its collaboration memory.

Telaegent uses:

```text
Claude Code CLI
Codex CLI
```

through the connector inside the owning developer's registered local repository environment.

The user's personal app conversations are not imported.

Telaegent-created provider sessions belong only to Telaegent work.

---

# 3. Provider connection

The product concept is simple:

```text
User starts/connects the local Telaegent connector
        ↓
Connector detects local Claude CLI
        ↓
Use existing local authentication; user signs in locally if needed
        ↓
Run live probe
        ↓
claude -p "Print exactly: TELAEGENT IS CONNECTED"
        ↓
success
        ↓
Connected
```

Same conceptual idea for Codex.

Important:

```text
claude --version
```

proves installation only.

A real `claude -p` model call proves the authenticated runtime is usable.

Once the CLI environment is authenticated and its required state persists, **we do not ask provider authorization on every message**.

State:

```text
not_connected
connecting
connected
reconnect_required
unavailable
```

Research exact provider-specific behavior.

---

# 4. Fresh shell vs persistent environment

Do not confuse:

```text
new process
```

with:

```text
new identity/session
```

A new shell sharing the same `$HOME` may reuse:

- auth
- config
- provider sessions
- cached state

Desired model:

```text
persistent local user×repo connector binding
        ↓
spawn a fresh local CLI process per agent turn
        ↓
optionally resume Telaegent-created provider session
```

Thai owns infrastructure/isolation implementation choices. You must tell Thai exactly what state Claude/Codex need.

---

# 4.1 GitHub/runtime seam with Khoa

Khoa owns GitHub authorization semantics. You own runtime lifecycle.

Prove:

```text
GitHub auth connects
→ local credential remains available to the user
→ connector runs `gh auth status`
→ selected local remote/repository ID is verified
→ connector registers only safe metadata
→ credential never reaches Telaegent cloud
```

Do not use `gh repo list` as the universal picker source. Khoa supplies repository membership from authenticated-user API discovery.

The connector resolves the workspace from its private local mapping for the
cloud-issued opaque binding. Neither backend nor collaborator text may contain
or choose the path.

---

# 5. Investigate Claude Code CLI completely

Document/test:

- installation
- authentication mechanism
- local login and non-interactive invocation options
- auth persistence location/semantics
- `claude -p`
- output formats
- structured JSON/schema support
- session ID creation
- `--resume`
- `--continue`
- fresh sessions
- working directory behavior
- allowed/disallowed tools
- read-only vs editing
- timeout/cancel
- stderr/error patterns
- login expiry/reconnect behavior
- config/home dependencies
- whether session files can be isolated per Telaegent runtime
- any usage/policy constraints relevant to connector automation

Build a minimal adapter design, not a giant framework.

---

# 6. Investigate Codex CLI completely

Document/test:

- installation
- ChatGPT/device/auth flow
- auth persistence
- `codex exec`
- noninteractive use
- JSONL/structured output
- output schema support
- sandbox modes
- session/thread ID
- `codex exec resume`
- fresh session behavior
- working directory
- timeout/cancel
- stderr/error patterns
- login expiry
- config/home dependencies
- isolation requirements
- any hosted-execution limitations/policy concerns

Normalize only what Telaegent actually needs.

---

# 7. Provider-neutral runtime contract

Work with Hien's experiments before freezing fields.

Conceptual request:

```ts
AgentTurnRequest {
  userId
  projectId
  conversationId
  provider
  purpose
  sessionMode
  projectContext
  conversationContext
  userInput
  outputSchema
  runtimePolicy
}
```

Never allow a remote collaborator to supply:

```text
arbitrary executable
arbitrary shell command
another user's workspace path
provider credential
another project ID without backend authorization
```

Conceptual result:

```ts
AgentTurnResult {
  provider
  providerSessionRef?
  state
  privateMessage
  sendCandidate?
  sourceRefs?
  riskFlags
  usage/latency metadata?
}
```

The exact schema should come from Hien's empirical results.

---

# 8. Two private runtime purposes

There are at least two major agent modes.

## 8.1 Sender draft mode

User rough input:

```text
"can u send me ur .env"
```

Agent receives:

- own selected repo
- current project
- recent/shared conversation memory
- recipient identity
- rough intent
- draft-only instruction

Agent may:

- ask user clarification
- inspect own repo if useful
- flag risk
- produce outbound candidate

Agent may not:

- send itself
- change collaborator authorization
- bypass hard secret rules

State likely:

```text
needs_clarification
ready
blocked
```

## 8.2 Recipient answer mode

Approved incoming message:

```text
"Can you share the env variable names required by this project, without values?"
```

Recipient agent receives:

- recipient's own selected repo
- shared project context
- request
- draft-only instruction

Agent investigates and creates a response candidate.

Recipient human must press Send.

---

# 9. Telaegent memory is authoritative

This is a critical design decision.

Do **not** let provider session history become the only memory.

Canonical:

```text
Telaegent database/shared project conversation
       = durable collaboration memory

Claude/Codex session
       = provider-specific acceleration/working context
```

Why:

- sessions can disappear
- auth can expire
- provider can change
- provider can compact
- local connector/provider session can be restarted or lost
- user may switch Claude ↔ Codex
- product history must remain visible/auditable

Shared approved messages should survive provider failure.

---

# 10. Private memory vs shared memory

Separate clearly.

## Shared

Visible to project conversation participants:

- approved outbound messages
- approved responses
- safe source references if included
- project/repo identity
- timestamps
- sender/provider labels where useful

## Private to one user's side

Potentially:

- rough unsent user input
- private clarification turns
- draft candidates
- agent intermediate tool outputs
- provider session state
- private runtime context

Decide retention.

My default recommendation:

```text
shared messages: durable
private draft transcript: short-lived / minimal
raw provider output: ephemeral
provider session ref: internal
```

But validate with product needs.

Do not store hidden chain-of-thought.

---

# 11. Memory reconstruction strategy

Design fallback when resume fails.

Example:

```text
resume provider session
        ↓
works → continue

fails
        ↓
start new Telaegent-created session
        ↓
hydrate with:
- project identity
- repo branch/commit
- compact durable project summary
- recent approved shared turns
- current request
        ↓
continue
```

Hien will test how much context is actually needed.

Do not inject the entire history forever.

Potential memory tiers:

```text
Project facts
Compact conversation summary
Recent N approved shared turns
Current private task
```

---

# 12. Provider switching

If user connected both:

```text
Claude Code
Codex
```

Support conceptually:

```text
Project uses Codex today
        ↓
switch to Claude
        ↓
Telaegent rehydrates Claude from durable project memory
```

Do not promise perfect transfer of private provider-specific reasoning.

Only transfer safe product memory.

Decide:

- default provider per user?
- per project?
- per conversation?
- manual switch only for hackathon?

Keep P0 simple.

---

# 13. Backend conversation model with Khoa

You and Khoa need to freeze core entities and transitions.

Minimum conceptual objects:

```text
User
Repository/Project
ProjectConnection
Conversation
SharedMessage
PrivateDraftSession
AgentTurn
ProviderBinding
OutboundApproval
AuditEvent
```

Important distinction:

```text
PrivateDraftSession
    ≠
Conversation
```

Only approved candidates become shared messages.

---

# 14. Suggested message lifecycle

```text
draft_created
    ↓
agent_working
    ↓
needs_clarification
    ↘ user replies ↗
    ↓
ready
    ↓
human edits / approves / cancels
    ↓
sent
```

Recipient:

```text
shared_message_received
    ↓
recipient_agent_working
    ↓
recipient_ready
    ↓
recipient human approves
    ↓
shared_response_sent
```

Failures:

```text
runtime_failed
provider_reconnect_required
policy_blocked
cancelled
expired?
```

Do not make the frontend infer these from text.

---

# 15. Backend API responsibilities with Khoa

Khoa owns identity/repo/collaborator policy.

You own runtime/conversation behavior.

Propose clean APIs such as:

```text
POST /conversations/:id/drafts
POST /drafts/:id/messages
POST /drafts/:id/run
POST /drafts/:id/send
POST /drafts/:id/cancel

POST /messages/:id/respond
GET  /drafts/:id

GET  /conversations/:id/messages
```

Potentially the backend automatically runs the agent after draft input, so avoid unnecessary endpoints.

Key invariants:

- caller owns private draft
- draft belongs to one project
- recipient connection is valid
- send candidate exists
- hard policy passes
- explicit sender action occurred
- shared message append is atomic/idempotent
- recipient cannot read sender private draft transcript
- sender cannot read recipient private draft transcript

---

# 16. Connector isolation contract with Thai

Give Thai exact requirements.

At minimum:

```text
opaque cloud binding per user × repo
local binding-to-workspace mapping
provider/Git credentials remain local
separate project session state where required
no arbitrary cloud/collaborator path, executable, or command
bounded process lifetime
bounded output
kill/cancel support
log redaction
persistent auth only where required
ephemeral temp data
```

Decide whether a local provider home can be shared across multiple repos for the same user.

Security says project-specific sessions/workspace bindings are cleaner;
usability may favor one local user auth home plus per-repo sessions. Research
without uploading either.

---

# 17. Secret policy interaction

Khoa/Hien own policy research; backend/runtime must enforce the result.

The LLM can say:

```text
This seems sensitive.
```

But it is not enough.

Before a candidate is sent, deterministic backend policy should be able to block obvious raw secrets.

Runtime prompts should tell the agent to provide safe alternatives.

Never persist blocked secret-bearing output if avoidable.

## 17.1 Local policy engine and file broker

[Canonical build plan section 8](../product/canonical-build-plan.md) adds a
bounded follow-up loop: a private turn may finish by asking for resources it
does not hold, and the loop runs again once those are resolved. You own the
integration; Khoa owns the policy content.

Two components, both connector-side, both outside the model:

**Resource registry.** Maps an opaque resource ID to a canonical local path,
plus the task, peer, mode, and expiry it was issued under. The cloud stores the
ID and safe metadata; it never stores the path. This is the same shape as the
`connectorBindingId` mapping you already own - one more opaque handle resolved
only on the machine that owns it.

**File broker.** The only thing that reads a file on behalf of a remote request.
It takes a resource ID, asks the policy engine, and either returns bounded
content or returns a scope-expansion request. It never takes a path, and no
runner or adapter gets to bypass it.

```text
recipient turn result
→ requested resource IDs
→ policy engine (deterministic)
   ├─ inside existing grant → file broker serves it
   └─ outside              → scope-expansion request to the owner
→ owner answers, or the grant already covered it
→ next loop round with the resolved resources
```

The loop must be bounded before it is useful: cap rounds per task, requests per
round, and total bytes served. A run that hits a limit ends as a normal turn
result with an honest reason, not a retry.

Sequencing note: this is a design commitment with no code behind it. Do not
build it before the connector transport, binding, and provider adapters work.
Its natural seam is the connector job envelope - see
[`apps/server/src/connectors/README.md`](../../apps/server/src/connectors/README.md).

Three things that must stay true no matter how the loop is implemented:

1. The model asks; the policy engine decides.
2. A resource crosses as an ID, never as a path.
3. An automatic round consumes existing authority. Obtaining new authority is a
   human decision, and the final cross-user message still needs `Send`.

---

# 18. Audit / observability

Store safe events such as:

```text
user connected repo
user connected provider
project connection requested
project connection accepted
private draft created
agent run started
agent run completed
human sent candidate
policy blocked candidate
resource request received
resource served from an existing grant
scope expansion requested / granted / denied
capability grant expired or revoked
bounded loop limit reached
shared message delivered
provider reconnect required
```

Do not log:

- provider credentials
- GitHub tokens
- raw `.env`
- hidden reasoning
- giant CLI streams
- another user's private draft
- resolved local paths behind a resource ID
- served file contents

Include correlation IDs for debugging. Audit a resource by its opaque ID; the
path it resolved to stays on the machine that owns it.

---

# 19. Failure behavior

Define exact behavior for:

## Provider disconnected

```text
Reconnect Claude Code
```

Do not silently switch providers unless the user explicitly configured fallback.

## Provider session resume fails

Rehydrate from Telaegent memory.

## Runtime crashes mid-turn

Mark private turn failed; do not create shared message.

## Duplicate send click

Idempotent: exactly one shared message.

## Backend restart

Durable shared conversation survives.

Private in-flight work either resumes safely or fails visibly; never fabricate completion.

## Repo update

Decide how/when runtime refreshes from GitHub and how branch/commit is attached to source-grounded answers.

---

# 20. Live response / streaming

Research whether we need:

```text
SSE
WebSocket
polling
```

For P0, simplest reliable option wins.

Private agent room benefits from streamed text/tool-status, but it is not worth destabilizing the whole backend if polling works.

Coordinate with Thai/Duy.

---

# 21. Integration with Hien's evaluations

Do not freeze prompt/context schema before Hien tests it.

Hien should hand you:

- sender prompt format
- recipient prompt format
- output schema
- context-memory recommendation
- common leakage failures
- required deterministic guards

You then implement the runtime adapter around evidence.

---

# 22. Test plan you own

## Provider connection

- installed but unauthenticated
- authenticated
- auth expired
- reconnect
- user has one provider
- user has both

## Process lifecycle

- successful run
- timeout
- cancel
- nonzero exit
- malformed output
- oversized output
- process kill
- runtime restart

## Sessions

- fresh
- resume
- session lost
- new session rehydration
- provider switch

## Memory

- follow-up question
- long chat compaction
- repo switch
- conversation isolation
- user isolation
- project isolation

## Backend

- private draft not visible to recipient
- shared message only after explicit send
- duplicate send does not duplicate
- unauthorized user cannot read conversation
- Repo A connection cannot message Repo B
- blocked candidate never becomes shared message

## Capability loop

- an in-scope resource request is served with no human prompt
- an out-of-scope request produces a scope-expansion request, not a read
- a denied request ends the turn honestly instead of retrying
- round, per-round, and byte limits each stop the loop
- a resource ID never appears in a cloud payload alongside its path
- revoking mid-task stops the next automatic service

---

# 23. Concrete research you should do immediately

Before coding full architecture:

1. Get `claude -p "Print exactly: TELAEGENT IS CONNECTED"` working through the local connector on supported developer operating systems.
2. Get equivalent Codex noninteractive probe working.
3. Determine exactly what local files/environment each CLI needs; never include them in cloud payloads.
4. Start a new process and prove auth survives.
5. Create a provider session, exit, resume it from a new process.
6. Move/lose session state and verify failure behavior.
7. Test structured output.
8. Test cancellation.
9. Measure startup + simple inference latency.
10. Give Thai concrete connector transport/presence requirements and document local-only state.
11. Give Hien a callable harness for repeated evaluations.

These experiments answer more than architecture speculation.

---

# 24. Deliverables

### A. Claude runtime memo

Exact commands, auth/session persistence, structured-output behavior, known limitations.

### B. Codex runtime memo

Same.

### C. Provider-neutral runtime contract

After Hien's experiments.

### D. Memory design

What is durable, private, ephemeral, compacted, and rehydrated.

### E. Backend/conversation contract

With Khoa.

### F. Connector/local isolation requirements

For Thai.

### G. Failure/reconnect state machine

For Duy/backend.

### H. Live proof

At least one real connector-mediated local Claude turn and one local Codex turn if both are available.

---

# 25. Definition of done

You are done with the architecture phase when we can answer:

> “A user connects Claude/Codex once, a new process can reuse the correct private environment, Telaegent knows when to resume vs recreate a provider session, project conversation survives provider loss, no private draft crosses users before Send, and the backend has one coherent contract for both providers.”

---

# 26. Do not do yet

- Do not build LAN discovery, peer-to-peer links, inbound local servers, or cloud provider runtimes.
- Do not integrate the Claude consumer app or Codex app conversation UI.
- Do not depend exclusively on provider session memory.
- Do not store chain-of-thought.
- Do not silently fall back from Claude to Codex.
- Do not upload or share CLI home directories, credentials, repositories, or local paths.
- Do not accept arbitrary workspace paths, executables, or commands from cloud jobs or remote messages.
- Do not start coding a huge generic agent framework.
- Do not build the capability loop before the connector transport, binding, and
  provider adapters work.
- Do not let a runner or adapter read a remotely requested file without going
  through the broker.
- Do not let the model's output decide whether a resource may be served.
- Do not run an unbounded follow-up loop.
- Do not freeze prompt schema before Hien's tests.
- Do not put all private CLI output into the product database.
