# Telaegent Final Build Plan

Status: final implementation plan for the 3–4 day hackathon build  
Audience: the five developers and their coding agents  
Canonical product specification: `TELAEGENT_PRODUCT_FLOW.md`

## 0. Instructions for every human and coding agent

Before changing code:

1. Read this file and `TELAEGENT_PRODUCT_FLOW.md` completely.
2. Preserve the product name **Telaegent**.
3. Preserve the full product sequence:

   > Publish intent → detect conflict → exchange structured status → propose a resolution → collect separate human approvals → transfer a permissioned, source-backed ContextPack → detect a dependency change → adapt the affected plan → complete with an auditable history.

4. Extend the Starter Kit; do not replace its React UI, Fastify server, `AgentService`, `AgentRunner`, per-Agent workspaces, Codex sessions, Runtime containers, or JSON persistence.
5. Work only in the files assigned in the five personal plans unless the current owner explicitly hands a file over.
6. Treat model output, repository content, paths, and tool arguments as untrusted input. Zod validation and deterministic policy checks are required before state changes or data disclosure.
7. Do not store hidden reasoning, complete private transcripts, raw internal prompts, environment files, credentials, or rejected secret-bearing model output.
8. Do not add a new database, message broker, vector database, router, cloud service, or authentication system during the hackathon.
9. Do not build automatic Git merging, remote multi-machine federation, full MCP, or full A2A compliance.
10. Run focused tests for every changed subsystem and run `npm run check` before merging.

The implementation target is a convincing, real vertical slice, not a general multi-agent platform.

---

## 1. Final product decision

### 1.1 Product definition

**Telaegent is coordination and trust middleware for separately owned coding agents.** It allows agents working on the same logical repository to expose bounded work intent, detect conflicts, negotiate a proposed work split, obtain human authorization, share only approved source-backed context, and adapt when a dependency changes.

The demonstration uses:

- One logical project: **Phoenix**
- Two mock owners: **Alice** and **Bob**
- Two separately owned coding Agents
- Two separate workspaces or Git worktrees from the same repository identity
- Alice's task: Google OAuth
- Bob's task: Redis-backed sessions
- One deterministic conflict over the `Session` contract
- One agreement that requires Alice and Bob to approve separately
- One approved ContextPack
- One `.env` request denied before file access
- One change that makes `deviceId` required
- One affected plan revision and final implementation run

### 1.2 Adaptations made from the coworker feedback

The coworker's proposal changes the implementation shape without changing the canonical product:

| Feedback | Final adaptation |
| --- | --- |
| Connect Codex and Claude Code in the same repo | Add provider adapters behind the Starter Kit's runner interface. Agents share a logical `projectId`, but write in separate branches/workspaces. They communicate through Telaegent, not by directly calling each other. |
| Specify the request format and permissions | Define a versioned `TelaegentEnvelope`, Zod schemas, idempotency, expiry, evidence, permission classes, error codes, and state machines. |
| Build a frontend/UI demo | Make the shared coordination conversation the main product surface. Tool actions, approvals, artifacts, and plan changes appear as inline cards. Add a small premium dark landing view inspired by the visual restraint of `x.ai/bot`, without copying its branding. |
| Decide whether to store Agent memory | Persist only bounded coordination memory and audit evidence in the existing JSON database. Keep private provider sessions separate. Do not add a vector database or copy full Agent memory. |
| Handle unanswered requests and security | Use durable asynchronous Operations and recipient inbox state. Return `202`, persist waiting state, poll snapshots, apply TTLs, and resume later. Use HTTPS only when remotely hosted; local MVP traffic stays on loopback or in-process. |
| Define tool calls and when to ask users | Implement a bounded Agent loop with typed logical tool calls. The policy engine executes safe calls, denies forbidden calls, and pauses on explicit human-decision cards. |
| Put the Agent loop inside the conversation | The UI shows action and observation, never hidden reasoning: user message → Agent step → tool request → policy result or approval → observation → resumed Agent step. |

### 1.3 Important scope change

The previous narrow scope excluded cross-vendor integration. This plan adds the smallest feasible cross-vendor layer: a local `CodexRunner` and a local `ClaudeCodeRunner` that normalize into the existing `AgentRunner` contract. It does **not** add a cross-vendor network protocol, remote sidecars, or full A2A compatibility.

The Day 0 go/no-go gate is credentials:

- Codex must run successfully because it is already the Starter Kit path.
- Claude Code must run successfully only if the team has a valid team-owned installation and authentication by the end of Day 0.
- The Claude adapter and parser are still P0 code and must be covered by fixture tests.
- If Claude credentials are unavailable, the judged live flow uses two real Codex Agents and the UI labels the provider honestly. Never fake a Claude live run.

---

## 2. Research-backed decisions

### 2.1 Why provider adapters are feasible

- Official Codex documentation describes `codex exec` as a stable non-interactive command, supports JSONL progress, resumable sessions, output JSON Schema validation, and `read-only` or `workspace-write` sandboxes. This matches the Starter Kit's existing runner approach.
- Official Claude Code documentation supports print mode, JSON or streaming JSON output, JSON Schema-constrained final output, resumable sessions, allowed/disallowed tools, maximum turns, and permission modes.
- Therefore, one normalized runtime request can safely target either provider without creating a new orchestration framework.

### 2.2 Why the request is a stateful asynchronous task

The A2A specification distinguishes messages, stateful tasks, artifacts, context identifiers, polling, streaming, and push updates. Telaegent borrows those proven concepts but implements only a small local HTTP contract:

- `requestId` identifies one request.
- `conversationId` groups related turns.
- `operationId` tracks background execution.
- `artifactId` identifies a validated result such as a ContextPack.
- HTTP `202` plus polling handles an Agent or owner who has not answered yet.
- TTL, cancellation, terminal states, and idempotency handle retries and stale work.

Telaegent must be described as **A2A-inspired**, not A2A-compliant.

### 2.3 Why permissions are visible and deterministic

The MCP tool specification recommends clear UI indicators for exposed tools, visible invocation state, and human ability to deny calls. Telaegent follows that interaction model, but the model does not enforce authorization. The TypeScript policy engine calculates the effective permission class from the operation and arguments.

### 2.4 Why memory is bounded

Hermes Agent separates small curated memory from searchable session history, injects bounded memory at session start, and warns against two Agents writing the same memory home. MemGPT similarly motivates separate memory tiers instead of treating the whole transcript as active context.

Telaegent adopts four explicit tiers:

1. **Run working context**: internal prompt/output for one runtime call; kept in memory and discarded after validation.
2. **Private provider session**: Codex or Claude session ID owned by one Agent; never shared with the other Agent.
3. **Shared coordination memory**: validated intent, agreement, source manifest, plan revision, and current status; persisted and deliberately small.
4. **Audit history**: append-only safe facts about who requested, approved, denied, changed, or completed something.

No long-term semantic memory provider or vector database is needed for the prototype.

### 2.5 Why the loop is action/observation based

ReAct demonstrates the usefulness of interleaving model reasoning and environment actions. Telaegent implements the externally visible part of that loop while keeping hidden reasoning private:

```text
Human message
    ↓
Agent returns a structured public summary and optional tool call
    ↓
Server validates schema, permission, state, and arguments
    ↓
Safe call executes OR forbidden call is denied OR human approval is requested
    ↓
The result becomes a structured observation in the conversation
    ↓
The same Agent session resumes with that observation
```

The loop is bounded to prevent endless Agent negotiation.

### 2.6 Security evidence applied

OWASP guidance for Agent and prompt-injection security emphasizes deterministic authorization, argument validation, least privilege, isolation of untrusted content, monitoring, and human review for consequential actions. Therefore:

- Repository text never grants permission.
- Model-selected paths never bypass the policy engine.
- Tool results are data, not instructions.
- Context generation runs in an isolated approved-source workspace.
- The model may propose an agreement, but cannot approve it.
- The model may request a file, but cannot grant itself access.
- All model output is parsed against a purpose-specific schema.

---

## 3. P0 scope, P1 hardening, and explicit cuts

### 3.1 P0: must work in the final demo

- Untouched Starter Kit Agent CRUD, lifecycle, Playground, persistence, and runtime still work.
- Runtime capability detection for Codex and Claude Code.
- Normalized Codex and Claude runner adapters.
- Phoenix fixture and two separate Agent workspaces/branches.
- Conversation-centered Telaegent UI.
- Publish and persist structured intents.
- Deterministic conflict detection.
- Bounded status retrieval from Bob's private Agent session.
- Model-proposed ownership resolution.
- Separate Alice and Bob approvals pinned to one proposal version.
- Alice implementation constrained by the active agreement.
- Context request with visible purpose, scope, owner, and expiry.
- Recipient approval of exact approved path rules.
- Isolated ContextPack generation and deterministic validation.
- `.env` denial before file open.
- Bob dependency-change publication.
- Alice impact detection and explicit plan delta.
- Alice approval of the new plan.
- Final implementation/test run and closeout.
- Safe audit timeline.
- Full fake-runner integration test.
- At least one genuine provider run in the rehearsed demo.

### 3.2 P1: implement after the P0 path is green

- Live Codex ↔ Claude demo when both credentials are available.
- Rejected agreement flow.
- Invalid ContextPack flow.
- Stale/offline status label.
- Expiry and restart recovery tests.
- Session detachment verification.
- Ownership-violation Git diff rejection.
- Landing-page motion and responsive polish.
- SSE progress if polling is proven insufficient.

### 3.3 Explicitly excluded

- Production login, OAuth, RBAC, or owner impersonation prevention
- Cross-machine discovery or networking
- Full A2A, MCP, or Agent Card implementation
- Agent-to-Agent direct private chat
- Shared raw memory or transcript sync
- Embeddings, vector storage, memory providers, knowledge graphs
- PostgreSQL, Redis, Kafka, RabbitMQ, DynamoDB, or S3
- ECS or cloud deployment before the local build is complete
- Automatic branch merging, conflict resolution, pull requests, or pushes
- More than one project, two owners, or two demo Agents
- Real Redis or Google OAuth credentials in the Phoenix fixture
- General glob language beyond exact files and `directory/**`
- Agent-authored permanent policy rules
- Automatic external network access
- Unlimited Agent loops or negotiation

---

## 4. Definition of done

The build is complete only when a fresh local setup can demonstrate this sequence:

1. Initialize Phoenix, Alice, and Bob.
2. Show each Agent's runtime provider and separate workspace/branch.
3. Bob submits “Migrate session storage to Redis.”
4. Bob's Agent publishes intent, performs a real checkpoint run, and reports progress.
5. Alice submits “Add Google OAuth.”
6. Alice's Agent plans without writing conflicting code.
7. The deterministic engine blocks/suspends implementation because the score is at least 5.
8. Telaegent obtains Bob's bounded structured status.
9. An Agent proposes the canonical ownership agreement.
10. Alice and Bob approve on separate controls; the agreement becomes active only after the second approval.
11. Alice's Agent resumes and implements only Alice-owned files/interfaces.
12. Alice's Agent requests Redis session architecture context.
13. Bob approves `docs/architecture/**`, `src/auth/**`, and `tests/auth/**` for that purpose and TTL.
14. Bob's Agent produces a source-backed ContextPack from an isolated workspace.
15. Telaegent validates and injects the pack into Alice's current task only.
16. A `.env` request is denied before any file content is opened.
17. Bob changes `SessionRepository.create` so `deviceId` is required.
18. Telaegent finds Alice's dependency and asks her Agent to revise its plan.
19. Alice sees original/revised steps and approves the plan delta.
20. Alice's Agent updates code, runs tests, and completes.
21. The visible audit timeline contains attributable evidence for every important stage.
22. `npm run check` passes.
23. The untouched Playground still completes a normal Agent run.

---

## 5. Starter Kit baseline and constraints

Use the actual Starter Kit seams already researched for this project:

- Node.js 22+ and npm 10+
- React 19 with Vite
- Frontend currently concentrated in `apps/web/src/App.tsx`, `api.ts`, `types.ts`, and `styles.css`
- No router or frontend state library
- Fastify 5 and Zod on the server
- Existing server files:
  - `apps/server/src/types.ts`
  - `apps/server/src/store.ts`
  - `apps/server/src/agent-service.ts`
  - `apps/server/src/app.ts`
  - `apps/server/src/index.ts`
  - `apps/server/src/codex-runner.ts`
  - `apps/server/src/container-codex-runner.ts`
  - `apps/server/src/runner-factory.ts`
  - `apps/server/src/workspace.ts`
  - `apps/server/src/config.ts`
- Existing `JsonStore` serializes mutations and performs atomic temporary-write plus rename. Extend it; do not replace it.
- Existing database version 1 contains Agents, messages, and runs. Add a `telaegent` property with safe defaults.
- Existing `AgentService` owns the one-active-run-per-Agent invariant and persistent Codex thread ID.
- Existing restart behavior cancels queued/running runs and resets busy Agents.
- Existing runner request has Agent ID, workspace, prompt, and thread ID.
- Existing Runtime supports local Codex and disposable containers.
- Default maximum run duration is 600 seconds and output is bounded.
- Existing workspaces need a real seeded Git fixture added.
- Existing server tests use Vitest.
- `npm run check` performs type checking, tests, and builds.
- Official `npm run poc` targets macOS/Linux. Native Windows work should use WSL2 or the team's Linux/macOS demo machine.
- Local POC is the primary judging path. ECS is optional and out of scope until everything else is frozen.

First commit after importing the Starter Kit must be an untouched baseline that passes its documented setup and acceptance flow.

---

## 6. Technology stack

| Layer | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript | Matches both Starter Kit applications and enables shared Zod-inferred types. |
| Frontend | React 19 + existing Vite setup | No migration risk. |
| Server | Fastify 5 | Existing control plane and route/test infrastructure. |
| Validation | Zod | Existing dependency; validates HTTP input, stored data, and model output. |
| Persistence | Existing atomic JSON store | Sufficient for one local project and avoids a database migration. |
| Runtime integration | Existing `AgentRunner` plus provider-specific adapters | Keeps lifecycle, busy lock, persistence, and containers centralized. |
| Coding providers | Codex CLI; Claude Code CLI when authenticated | Both support non-interactive structured execution and resumable sessions. |
| Async delivery | Persisted Operations + snapshot polling every ~900 ms | Works across long model calls and page refresh without adding WebSockets or a queue. |
| Repository evidence | Git via `execFile` argument arrays | Safe branch/commit/diff checks without shell interpolation. |
| Testing | Vitest + Fastify inject + fake runners | Existing stack and deterministic workflow coverage. |
| Deployment | Local macOS/Linux/WSL2; existing container runtime | Best chance of a reproducible 3-minute demo. |

Do not add LangChain, a multi-agent framework, Prisma, React Router, Redux, Tailwind, or a component library during the event.

---

## 7. System architecture

```text
┌──────────────────────────────── React/Vite ────────────────────────────────┐
│ Landing view                                                               │
│ Product shell                                                              │
│  ├─ Agent/owner switcher                                                   │
│  ├─ Shared coordination conversation                                       │
│  ├─ Inline tool, approval, ContextPack, and plan-diff cards                │
│  ├─ Team state drawer                                                      │
│  └─ Audit drawer                                                           │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ HTTP JSON; polling while active
┌───────────────────────────────▼─────────────────────────────────────────────┐
│ Fastify                                                                    │
│  ├─ Existing Agent routes                                                  │
│  └─ /api/telaegent routes                                                   │
│       └─ TelaegentService / ConversationOrchestrator                         │
│            ├─ Envelope/schema validation                                   │
│            ├─ Agent-loop controller                                        │
│            ├─ Conflict + dependency engines                                │
│            ├─ Agreement + permission engines                               │
│            ├─ Tool dispatcher                                              │
│            ├─ Context isolation + validation                               │
│            ├─ Safe shared memory                                           │
│            └─ Audit events                                                  │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ only through AgentService
┌───────────────────────────────▼─────────────────────────────────────────────┐
│ Existing AgentService                                                      │
│  ├─ one active run per Agent                                               │
│  ├─ run persistence and cancellation                                       │
│  ├─ visible normal Playground turns                                        │
│  ├─ private middleware turns                                               │
│  └─ provider session IDs                                                   │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ normalized RunnerRequest
                ┌───────────────┴────────────────┐
                ▼                                ▼
       CodexRunner / container          ClaudeCodeRunner
       JSONL + output schema             stream-json + json schema
                │                                │
                └──────── separate Agent workspace/branch ────────┘
```

### 7.1 Non-negotiable boundaries

- `TelaegentService` may invoke an Agent only through `AgentService`.
- No Telaegent route may call a runner directly.
- `AgentService` remains the single owner of busy locks, run lifecycle, cancellation, and provider session updates.
- Normal Playground messages keep their existing behavior.
- Internal middleware prompts and raw outputs do not enter the public message history.
- Only `TelaegentService` may turn validated internal output into a shared conversation entry.
- Only the deterministic policy engine may authorize source access.

---

## 8. Same-repository identity and workspace isolation

“In the same repo” must not mean two autonomous coding processes editing one working directory concurrently.

### 8.1 Logical project identity

Seed the repository with:

```json
{
  "schemaVersion": 1,
  "projectId": "phoenix",
  "name": "Phoenix Web App"
}
```

at `.telaegent/project.json`. Copies and worktrees inherit the same `projectId`. The server also records:

- normalized Git remote when present
- base commit
- workspace root
- branch
- Agent ID
- owner ID
- provider

For the prototype, matching `projectId` is authoritative. Remote URL and base commit are evidence, not authentication.

### 8.2 Workspace rule

- Alice: `phoenix-alice`, branch `feature/google-oauth`
- Bob: `phoenix-bob`, branch `feature/redis-sessions`
- Each run receives exactly one workspace root.
- No run can write outside its workspace.
- ContextPack generation receives a third temporary read-only workspace containing only approved sources.
- Telaegent never merges the two branches.

### 8.3 Git checkpoint rule

After a successful implementation stage:

1. Read `git status --porcelain` through `execFile`.
2. Reject absolute paths, submodules, symlink escapes, and changes outside the intended ownership scope.
3. Run the fixture tests.
4. Create a local checkpoint commit with a deterministic demo identity.
5. Store commit ID and changed paths as evidence.
6. Do not push or merge.

---

## 9. Provider runtime layer

### 9.1 Normalized types

Extend the runner boundary conceptually as follows:

```ts
type AgentProvider = "codex" | "claude";
type RunPurpose =
  | "plan_intent"
  | "implement"
  | "status"
  | "propose_resolution"
  | "create_context_pack"
  | "publish_dependency_change"
  | "revise_plan";

type SessionMode = "continue" | "fresh" | "ephemeral";
type SandboxMode = "read-only" | "workspace-write";

interface MiddlewareRunRequest {
  agentId: string;
  provider: AgentProvider;
  purpose: RunPurpose;
  workspacePath: string;
  runtimePrompt: string;
  persistedSummary: string;
  sessionId?: string;
  sessionMode: SessionMode;
  sandboxMode: SandboxMode;
  networkMode: "none" | "default";
  outputSchemaName: string;
  correlationId: string;
  maxTurns: number;
}

interface NormalizedRunResult<T> {
  provider: AgentProvider;
  sessionId?: string;
  final: T;
  changedFiles: string[];
  exitCode: number;
  durationMs: number;
}
```

### 9.2 Codex adapter

Reuse and extend the existing Codex runner:

- Use `codex exec` for new non-interactive runs.
- Use `codex exec resume <sessionId>` for a bounded continuation.
- Use JSONL output for lifecycle/session events.
- Use `--output-schema <path>` for each structured operation.
- Use `--sandbox read-only` for planning, status, proposal, ContextPack, and replan.
- Use `--sandbox workspace-write` for implementation.
- Never use a sandbox-bypass flag.
- Preserve current ModelArk configuration from the Starter Kit.

### 9.3 Claude Code adapter

Add `apps/server/src/claude-code-runner.ts` implementing the same runner contract:

- Invoke through `execFile`/spawn argument arrays, never a concatenated shell string.
- Use `claude -p` for non-interactive execution.
- Use `--output-format stream-json` and parse line-by-line.
- Use `--json-schema <schema-json>` for the final structured result.
- Use `--resume <sessionId>` only for the owning Agent's continued session.
- Use `--max-turns` to bound each runtime call.
- Planning/status/context runs use plan/read-only-compatible permission configuration and no edit tools.
- Implementation runs expose only the minimum read/edit/test tools needed for the fixture.
- Do not use `--dangerously-skip-permissions`.
- Do not forward subagent text or hidden thinking into Telaegent.
- Capture only the final validated object and necessary lifecycle metadata.

### 9.4 Capability endpoint

`GET /api/telaegent/runtime-capabilities` returns:

```json
{
  "codex": { "installed": true, "authenticated": true, "reason": null },
  "claude": { "installed": true, "authenticated": false, "reason": "login_required" }
}
```

Never return executable paths, tokens, home directories, or credential details.

### 9.5 AgentService additions

Keep existing `sendMessage()` unchanged and add two explicit paths:

```ts
runMiddlewareTurn(request: MiddlewareRunRequest): Promise<NormalizedRunResult<unknown>>

sendVisibleCoordinatedMessage(input: {
  agentId: string;
  displayedPrompt: string;
  runtimePrompt: string;
  constraints: ActiveAgreement;
  correlationId: string;
}): Promise<AgentRun>
```

`runMiddlewareTurn()` must:

- reuse the Agent busy lock
- create an internal Run with a safe purpose summary
- never store `runtimePrompt` in normal messages
- keep raw output in memory only
- validate/redact before persistence
- update the provider session only when `sessionMode === "continue"`
- ignore/detach session IDs for `fresh` or `ephemeral` runs
- map restart/cancel to the associated Telaegent Operation

`sendVisibleCoordinatedMessage()` must:

- display the original human task in the normal UI
- send internal ownership and ContextPack constraints only to the runtime
- redact the final assistant content before storing it
- verify changed files before checkpointing

---

## 10. Conversation-centered Agent loop

### 10.1 Public conversation entries

The shared conversation is not a copy of either provider transcript. It contains safe entries only:

```ts
type ConversationEntryType =
  | "human_message"
  | "agent_summary"
  | "tool_call"
  | "tool_result"
  | "permission_request"
  | "permission_decision"
  | "context_pack"
  | "dependency_change"
  | "plan_diff"
  | "system_event"
  | "error";
```

Every entry has `entryId`, `conversationId`, `actor`, `type`, safe `payload`, `operationId?`, `correlationId`, and `createdAt`.

### 10.2 Structured Agent step

Each middleware run ends with a purpose-specific object whose common wrapper is:

```json
{
  "publicSummary": "I found that OAuth depends on the shared Session contract.",
  "nextAction": {
    "name": "relay_publish_intent",
    "arguments": {}
  },
  "taskState": "working"
}
```

Rules:

- `publicSummary` is short and safe for the shared thread.
- At most one `nextAction` is accepted per step.
- The server chooses the allowed tool set from `purpose`; the Agent does not.
- A missing or invalid action can receive one structured repair attempt.
- A second invalid result fails the Operation with `INVALID_AGENT_OUTPUT`.
- Maximum internal steps per stage: 3.
- Maximum inter-Agent exchanges per coordination request: 3.

### 10.3 Loop controller

Pseudo-code:

```ts
for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
  const candidate = await agentService.runMiddlewareTurn(...);
  const parsed = schemaForPurpose.parse(candidate.final);
  appendSafeAgentSummary(parsed.publicSummary);

  if (!parsed.nextAction) return completeStage(parsed);

  const decision = policy.evaluate(parsed.nextAction, currentState);

  if (decision.kind === "deny") {
    appendToolResult(decision.safeReason);
    return completeOrEscalate();
  }

  if (decision.kind === "ask_human") {
    createPermissionRequest(decision);
    return pauseOperation("input_required");
  }

  const observation = await toolDispatcher.execute(parsed.nextAction);
  appendToolCallAndResult(observation);
  prompt = buildResumePrompt(observation);
}

return escalate("EXCHANGE_LIMIT");
```

When a human responds, a new service call validates the decision, records it, sets the Operation to queued, and resumes the loop with a structured observation.

---

## 11. Versioned request format

### 11.1 Telaegent envelope

Every Agent-to-Telaegent or internal routed request uses this logical structure:

```ts
interface TelaegentEnvelope<TPayload> {
  schemaVersion: "telaegent.v1";
  requestId: string;
  correlationId: string;
  idempotencyKey: string;
  projectId: string;
  conversationId: string;
  intentId?: string;
  sender: {
    ownerId: string;
    agentId: string;
    provider: "codex" | "claude";
  };
  recipient?: {
    ownerId: string;
    agentId: string;
  };
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
    sourceRefs?: Array<{ path: string; commit: string; sha256?: string }>;
  };
}
```

The caller does **not** provide the authoritative permission class. The server derives it from `operation`, arguments, active agreement, source policy, and owner identity.

### 11.2 Example context request

```json
{
  "schemaVersion": "telaegent.v1",
  "requestId": "req_ctx_01",
  "correlationId": "corr_demo_01",
  "idempotencyKey": "alice-context-redis-v1",
  "projectId": "phoenix",
  "conversationId": "conv_phoenix_demo",
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
    "topic": "Redis session architecture",
    "purpose": "Implement Google OAuth",
    "requestedPaths": [
      "docs/architecture/**",
      "src/auth/**",
      "tests/auth/**"
    ],
    "persistence": "current-task-only"
  },
  "delivery": {
    "mode": "async",
    "exchangeNumber": 1,
    "createdAt": "2026-08-28T02:00:00.000Z",
    "expiresAt": "2026-08-28T02:15:00.000Z"
  },
  "evidence": {
    "branch": "feature/google-oauth",
    "baseCommit": "af31d4e"
  }
}
```

### 11.3 Async acknowledgement

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
```

```json
{
  "operationId": "op_01",
  "requestId": "req_ctx_01",
  "correlationId": "corr_demo_01",
  "state": "waiting_for_recipient",
  "pollUrl": "/api/telaegent/operations/op_01"
}
```

### 11.4 Idempotency and ordering

- `idempotencyKey` is unique within project + sender + operation.
- A duplicate request returns the original Operation, not a second request.
- Every stored event receives a monotonically increasing `sequence` from the store mutation.
- Decisions include `targetVersion`; stale approvals receive `412 STALE_VERSION`.
- Terminal Operations cannot accept new replies.
- A response after expiry receives `410 EXPIRED` and does not resume an Agent.

### 11.5 Error envelope

```json
{
  "error": {
    "code": "POLICY_DENIED",
    "message": "The requested path is always forbidden.",
    "safeDetails": { "rule": "FORBID_ENV_FILES" },
    "correlationId": "corr_demo_01",
    "auditEventId": "evt_42"
  }
}
```

Required codes:

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 400 | `INVALID_REQUEST` | HTTP or envelope schema failed. |
| 403 | `POLICY_DENIED` | A deterministic permission/path rule denied the action. |
| 409 | `INVALID_STATE` | The transition is not legal. |
| 409 | `AGENT_BUSY` | The owning Agent already has an active run. |
| 410 | `EXPIRED` | Request, approval, or pack expired. |
| 412 | `STALE_VERSION` | Approval references an old proposal/status/plan version. |
| 422 | `INVALID_AGENT_OUTPUT` | Model output failed its schema after one repair. |
| 422 | `OWNERSHIP_VIOLATION` | Git diff crosses the approved work boundary. |
| 429 | `EXCHANGE_LIMIT` | Bounded loop or coordination limit reached. |
| 503 | `RUNTIME_UNAVAILABLE` | Provider is missing, unauthenticated, or failed to start. |

---

## 12. Permission model

### 12.1 Permission classes

```ts
type PermissionClass =
  | "AUTO_METADATA"
  | "RECIPIENT_SOURCE_APPROVAL"
  | "DUAL_OWNER_COMMITMENT"
  | "AFFECTED_OWNER_APPROVAL"
  | "ALWAYS_DENY";
```

| Class | Examples | UI | Who decides |
| --- | --- | --- | --- |
| `AUTO_METADATA` | Task, branch, progress, planned/changed paths, interfaces, dependency name | Compact tool/result card | Server policy after validation |
| `RECIPIENT_SOURCE_APPROVAL` | Read approved code/docs and generate a ContextPack | Permission card with purpose, paths, TTL | Owner of the source Agent |
| `DUAL_OWNER_COMMITMENT` | Activate ownership agreement or architectural work split | One card with independent Alice/Bob decisions | Both owners; exact proposal version |
| `AFFECTED_OWNER_APPROVAL` | Accept a revised plan after dependency change | Before/after plan card | Owner of affected Agent |
| `ALWAYS_DENY` | `.env`, credentials, outside workspace, private transcript, hidden reasoning | Red denial card; no Approve button | Deterministic policy only |

### 12.2 Permission card requirements

Every permission card must show:

- requesting Agent and owner
- receiving Agent and owner
- exact human-readable purpose
- requested action
- exact path rules or ownership rules
- persistence duration and expiry
- risk label
- source commit/version
- what will be stored
- what will never be shared
- Approve once and Deny buttons when approval is possible
- separate Alice/Bob decision state for dual approval
- final outcome and audit event ID

The UI must never show a generic “Allow everything” option.

### 12.3 Path rules

Supported allow rules only:

- exact relative file: `src/auth/session.ts`
- recursive directory prefix: `src/auth/**`

Reject before file access:

- absolute paths
- `..` traversal after normalization
- empty or NUL-containing paths
- `.env` and `.env.*`
- `.git/**`
- names suggesting secrets, credentials, tokens, private keys, SSH keys, or cloud credentials
- files outside the canonical workspace root
- symlinks resolving outside the workspace
- unsupported glob syntax

Limits:

- maximum 5 approved path rules
- maximum 8 source files
- maximum 32 KiB per file
- maximum 64 KiB total copied sources
- maximum 8 KiB ContextPack JSON
- ContextPack TTL 15 minutes
- status considered stale after 5 minutes
- coordination request TTL 30 minutes
- maximum 3 inter-Agent exchanges

---

## 13. Logical tool calls

These are typed logical calls emitted in structured Agent output and executed by the server dispatcher. They are not a full MCP server in the hackathon version.

The six canonical relay operations remain present: `relay_publish_intent`, `relay_update_progress`, `relay_ask_status`, `relay_request_context`, `relay_reply`, and `relay_complete_task`. The additional names below are typed specializations used by the bounded conversation loop. `relay_reply` sends a schema-constrained response to an existing pending request and inherits that request's permission, recipient, version, and expiry; it cannot create a new grant.

### 13.1 Agent-callable tools

| Tool | Purpose | Permission behavior | Deterministic validation |
| --- | --- | --- | --- |
| `relay_publish_intent` | Publish task, planned files, interfaces, dependencies, branch | Auto metadata | Same project, valid branch/path/interface schema |
| `relay_update_progress` | Publish changed files, progress, blockers, freshness | Auto metadata | Owning Agent, progress 0–100, Git evidence |
| `relay_ask_status` | Request bounded current status from another Agent | Auto metadata; stale rules apply | Same project, active request, exchange limit |
| `relay_reply` | Reply to a pending status/context/coordination request | Inherits original request; cannot expand scope | Valid `replyToRequestId`, sender/recipient, schema, version, TTL |
| `relay_suggest_resolution` | Propose ownership split and dependency rules | Creates dual approval | Must reference actual conflicting intents and version |
| `relay_request_context` | Ask for purpose-specific source context | Recipient approval | Purpose, exact paths/categories, TTL, forbidden path precheck |
| `relay_create_context_pack` | Create a source-backed pack from approved files | Uses existing approval | Isolated workspace, fresh session, source manifest |
| `relay_report_dependency_change` | Report changed interface/API/schema | Auto metadata | Source path/commit exists; interface matches active work |
| `relay_propose_replan` | Return original/revised plan and affected paths | Affected-owner approval | Must preserve active ownership agreement |
| `relay_complete_task` | Mark intent complete with tests/commit evidence | Auto after checks | Tests pass, diff within ownership, valid checkpoint |
| `relay_request_human_decision` | Pause because a consequential or unclear choice is required | Creates correct approval type | Reason code and bounded options required |

### 13.2 Human-only actions

Never expose these as freely callable model tools:

- `decide_agreement`
- `decide_context_request`
- `decide_plan_revision`
- `cancel_operation`
- `reset_demo`

### 13.3 Server-only tools

The model cannot invoke or override these directly:

- `evaluate_conflict`
- `evaluate_permission`
- `grant_source_scope`
- `deny_source_scope`
- `safe_read_approved_sources`
- `validate_context_pack`
- `detect_dependency_impact`
- `verify_git_diff`
- `record_audit_event`
- `expire_request`

### 13.4 Mapping the coworker's examples

- “Create a file that can be accessed” → a human approves a source scope; the server copies the approved file into an isolated Context workspace.
- “Create a file that cannot be accessed” → the server policy denies it; the model cannot weaken the rule.
- “Create a rule that must be followed” → `relay_suggest_resolution` proposes an `ownershipRule`; it becomes active only after both owners approve.
- “Suggest a fix” → `relay_suggest_resolution` or `relay_propose_replan`.
- “When to ask the user” → `relay_request_human_decision` when a permission class is consequential, required context is not approved, status is stale, the proposal is ambiguous, or the bounded exchange limit is reached.

---

## 14. Deterministic conflict and dependency logic

### 14.1 Conflict scoring

Normalize slashes, strip `./`, reject invalid paths, and lowercase interface identifiers for comparison.

| Signal | Score |
| --- | ---: |
| Same currently modified file | +5 |
| One planned file overlaps the other's modified file | +4 |
| Same interface, API, or schema | +4 |
| Same planned file | +3 |
| Same immediate module/directory | +1 |
| Different non-empty base commits | +1 |

Use the strongest exact file signal once per path pair; do not double-count the same overlap.

- 0–2: no warning
- 3–4: coordination suggested
- 5+: implementation pauses until coordination is acknowledged

For the demo, shared `Session` gives +4 and the shared `src/auth` module gives +1, producing a blocking score of 5.

The model may explain the conflict but may not change the score or threshold.

### 14.2 Dependency impact

When Bob publishes `SessionRepository.create now requires deviceId`:

1. Validate source path and commit.
2. Normalize changed interface name.
3. Find active intents whose interfaces/dependencies contain `Session` or `SessionRepository`.
4. Check the active agreement's dependency links.
5. Create one `DependencyChange` and one `PlanRevision` request for Alice.
6. Pause Alice at `awaiting_replan` before further implementation.
7. Ask Alice's existing session for an original/revised plan delta.
8. Validate that revised files remain Alice-owned.
9. Require Alice's explicit approval.
10. Resume implementation with the approved delta.

---

## 15. Shared coordination memory and persistence

### 15.1 Decision: use the existing database, but not as full Agent memory

Yes, persist memory needed for correctness and demo continuity. No, do not persist private Agent memory or all messages.

Persist:

- project and mock owner bindings
- provider and workspace binding
- safe shared conversation entries
- current intent/checkpoint
- deterministic conflict evidence
- proposal and exact approval versions
- approved path rules and expiry
- ContextPack manifest and validated bounded content
- dependency changes and plan revisions
- operation state
- audit events

Do not persist:

- hidden reasoning
- full Codex or Claude transcripts
- raw runtime prompts
- raw unvalidated output
- rejected secret-like content
- source file bodies outside the final bounded ContextPack
- `.env` contents
- provider credentials
- Claude/Codex home directories

### 15.2 Database shape

Extend the existing version-1 database compatibly:

```ts
interface Database {
  version: 1;
  agents: Agent[];
  messages: AgentMessage[];
  runs: AgentRun[];
  telaegent: TelaegentDatabase;
}

interface TelaegentDatabase {
  projects: Project[];
  owners: Owner[];
  agentBindings: AgentBinding[];
  conversations: CoordinationConversation[];
  conversationEntries: ConversationEntry[];
  intents: Intent[];
  coordinationRequests: CoordinationRequest[];
  agreements: Agreement[];
  contextRequests: ContextRequest[];
  contextPacks: ContextPack[];
  dependencyChanges: DependencyChange[];
  planRevisions: PlanRevision[];
  operations: Operation[];
  events: AuditEvent[];
  idempotencyRecords: IdempotencyRecord[];
}
```

On reading an old database, initialize `telaegent` with empty arrays without changing existing Agent data.

### 15.3 Core records

`AgentBinding`:

- `agentId`, `ownerId`, `projectId`
- `provider`
- `workspacePath`, `branch`, `baseCommit`
- `providerSessionId?`
- `activeIntentId?`

`Intent`:

- IDs and owner/Agent/project binding
- task, branch, base commit
- planned/changed files
- interfaces and dependencies
- plan steps
- progress and freshness
- planning/implementation run IDs
- status and timestamps

Intent statuses:

`planning`, `active`, `coordination_required`, `implementing`, `awaiting_context`, `awaiting_replan`, `completed`, `failed`, `cancelled`.

`CoordinationRequest`:

- participant intents and Agents
- conflict score/signals
- verified/stale status snapshot
- exchange count
- proposal ID
- state, version, expiry, timestamps

Coordination states:

`detected`, `status_pending`, `proposal_ready`, `awaiting_approvals`, `active`, `rejected`, `escalated`, `expired`, `completed`.

`Agreement`:

- proposal version
- Alice/Bob ownership lists
- dependency links
- required rules
- independent approvals with owner, decision, version, timestamp
- state: `proposed`, `active`, `rejected`, `superseded`, `completed`

`ContextRequest`:

- sender/recipient, topic, purpose
- requested/approved rules
- state and decision
- persistence scope and expiry

Context states:

`requested`, `denied`, `approved`, `generating`, `validated`, `delivered`, `rejected`, `expired`.

`ContextPack`:

- topic, summary, implementation steps, validation checklist
- trusted source manifest with path, commit, SHA-256
- sharedBy, task scope, expiry
- state: `candidate`, `validated`, `delivered`, `rejected`, `expired`

`PlanRevision`:

- dependency change ID
- original and revised steps
- affected files
- validation result
- owner decision
- state: `proposed`, `approved`, `rejected`, `applied`

`Operation`:

- type, Agent, Run, intent, correlation/request IDs
- `state`, safe error, timestamps

Operation states:

`accepted`, `queued`, `running`, `waiting_for_recipient`, `input_required`, `completed`, `failed`, `cancelled`, `expired`, `escalated`.

`AuditEvent`:

- event ID and monotonic sequence
- project/conversation/correlation IDs
- actor type and ID
- event type, outcome, safe payload, timestamp

---

## 16. Backend implementation

### 16.1 Files to modify

- `apps/server/src/types.ts`
- `apps/server/src/store.ts`
- `apps/server/src/agent-service.ts`
- `apps/server/src/codex-runner.ts`
- `apps/server/src/container-codex-runner.ts`
- `apps/server/src/runner-factory.ts`
- `apps/server/src/config.ts`
- `apps/server/src/app.ts`
- `apps/server/src/index.ts`

### 16.2 Files to add

```text
apps/server/src/claude-code-runner.ts
apps/server/src/telaegent/types.ts
apps/server/src/telaegent/schemas.ts
apps/server/src/telaegent/constants.ts
apps/server/src/telaegent/service.ts
apps/server/src/telaegent/routes.ts
apps/server/src/telaegent/conversation-orchestrator.ts
apps/server/src/telaegent/tool-dispatcher.ts
apps/server/src/telaegent/conflict-engine.ts
apps/server/src/telaegent/agreement-engine.ts
apps/server/src/telaegent/permission-engine.ts
apps/server/src/telaegent/context-policy.ts
apps/server/src/telaegent/context-workspace.ts
apps/server/src/telaegent/context-pack-validator.ts
apps/server/src/telaegent/dependency-impact.ts
apps/server/src/telaegent/redaction.ts
apps/server/src/telaegent/git-helper.ts
apps/server/src/telaegent/phoenix-fixture.ts
apps/server/src/telaegent/prompts/plan-intent.ts
apps/server/src/telaegent/prompts/ask-status.ts
apps/server/src/telaegent/prompts/propose-resolution.ts
apps/server/src/telaegent/prompts/implement-with-agreement.ts
apps/server/src/telaegent/prompts/request-context.ts
apps/server/src/telaegent/prompts/create-context-pack.ts
apps/server/src/telaegent/prompts/publish-dependency-change.ts
apps/server/src/telaegent/prompts/revise-plan.ts
apps/server/src/telaegent/output-schemas/*.json
```

If the Starter Kit layout differs after cloning, keep responsibilities the same and document the mapping in the pull request.

### 16.3 Service responsibilities

`TelaegentService` is the transaction boundary for each state transition. Every public method must:

1. Parse input.
2. Load required records.
3. Validate actor/project/version/state.
4. Evaluate deterministic policy.
5. Apply one atomic store mutation for state + audit event.
6. Start any long Agent work outside the store lock.
7. Apply the validated result in another atomic mutation.
8. Return a safe snapshot or Operation handle.

Do not hold the store mutation queue while waiting for a provider run.

### 16.4 Context isolation sequence

1. Validate request, approval, scope, project, task, and expiry.
2. Normalize approved rules.
3. Walk candidate paths without following unvalidated symlinks.
4. Reject forbidden/oversized files before reading content.
5. Create a temporary directory.
6. Copy only approved files, preserving relative paths.
7. Create a trusted `manifest.json` containing path, commit, size, and SHA-256.
8. Run Bob's provider in that temporary workspace, read-only, network disabled, fresh/ephemeral session.
9. Parse the ContextPack candidate.
10. Verify every cited source is in the trusted manifest.
11. Scan candidate fields for secret-like content and prompt-injection indicators.
12. Replace model-provided source metadata with trusted manifest metadata.
13. Persist only the validated bounded pack.
14. Delete the temporary directory through the fixture's safe cleanup helper.
15. Inject the pack into Alice's next current-task prompt.
16. Expire the pack on completion or TTL.

Known limitation to disclose: provider session data may remain on the local host according to provider behavior. Telaegent detaches the ContextPack session and never shares its ID, but does not claim secure deletion of provider-owned session files.

### 16.5 Redaction

Redact before persistence or UI serialization:

- common API key/token/private key formats
- bearer/basic authorization headers
- credential-looking assignments
- full local workspace/home paths where not required
- internal runtime prompt text
- raw stack traces containing environment data

Store a safe reason and hash/digest when evidence is needed; do not store the secret-bearing original.

---

## 17. HTTP API

All routes use the `/api/telaegent` prefix.

### 17.1 Setup and read APIs

| Method | Route | Result |
| --- | --- | --- |
| `POST` | `/demo/initialize` | Seed Phoenix, owners, Agents, workspaces, fixture, branches, and conversation. |
| `POST` | `/demo/reset` | Reset only known demo records/workspaces after exact target validation. |
| `GET` | `/runtime-capabilities` | Safe Codex/Claude availability. |
| `GET` | `/projects/phoenix/snapshot` | One complete UI snapshot. |
| `GET` | `/operations/:operationId` | Operation state and safe result/error. |

### 17.2 Conversation and workflow APIs

| Method | Route | Result |
| --- | --- | --- |
| `POST` | `/conversations/:conversationId/messages` | Submit a human task/message and receive `202 Operation`. |
| `POST` | `/intents/:intentId/continue` | Resume approved implementation. |
| `POST` | `/intents/:intentId/complete` | Verify and close an intent. |
| `POST` | `/coordination/:requestId/status` | Trigger bounded recipient status. |
| `POST` | `/coordination/:requestId/proposal` | Trigger structured resolution proposal. |
| `POST` | `/agreements/:agreementId/decision` | Record one owner's version-pinned approve/reject. |
| `POST` | `/context-requests` | Create a context request. |
| `POST` | `/context-requests/:requestId/decision` | Recipient approves exact paths or denies. |
| `POST` | `/context-requests/:requestId/generate` | Generate/validate/deliver ContextPack. |
| `POST` | `/intents/:intentId/dependency-change` | Publish a validated dependency change. |
| `POST` | `/impacts/:impactId/replan` | Ask affected Agent for plan delta. |
| `POST` | `/replans/:revisionId/decision` | Affected owner approves/rejects. |

The frontend must not infer workflow transitions. It renders server-provided state and allowed actions.

### 17.3 Snapshot response

Return one shape containing:

- project
- owners and Agent bindings
- conversation and safe entries
- active intents
- coordination request/agreement
- context request/pack
- dependency change/revision
- active Operations
- audit events
- `allowedActions` calculated by the server

This avoids races from fetching many endpoints independently during the demo.

---

## 18. Frontend and UI/UX

### 18.1 Product structure

Do not add React Router. Use a small hash/view switch:

- `#/` → landing view
- `#/demo` → Telaegent product
- Playground remains accessible from the product header

### 18.2 Landing direction

Use the restraint observed on the reference landing page:

- near-black background
- compact top navigation
- large centered headline
- short one-sentence product promise
- one primary CTA and one secondary CTA
- a product window mock/preview beneath the hero
- generous whitespace
- subtle borders and one restrained accent color

Suggested copy:

```text
Agents can work together without oversharing.

Telaegent detects collisions, asks the right people, transfers only approved
context, and keeps every decision auditable.
```

Primary CTA: `Launch Phoenix demo`  
Secondary CTA: `See how it works`

Do not spend more than half a day on the landing page. The judged product is the working coordination conversation.

### 18.3 Product shell

Desktop layout:

```text
┌──────────────┬──────────────────────────────────┬────────────────────┐
│ Agents       │ Shared coordination conversation │ Context / audit    │
│ Alice        │ message + inline action cards     │ selected details   │
│ Bob          │ composer at bottom                │ allowed actions    │
└──────────────┴──────────────────────────────────┴────────────────────┘
```

On narrow screens, the right drawer becomes a modal/bottom sheet and the Agent rail becomes a top switcher.

### 18.4 Conversation cards

- `IntentCard`: task, provider, branch, planned files, interfaces.
- `ConflictCard`: deterministic score and signals; visually distinct.
- `StatusCard`: structured status, progress, timestamp, fresh/stale badge.
- `ProposalCard`: ownership columns and dependency rules.
- `DualApprovalCard`: separate Alice/Bob state and buttons.
- `ToolCallCard`: tool name, safe arguments summary, running/completed/denied state.
- `PermissionCard`: purpose, paths, TTL, stored/not-shared explanation.
- `ContextPackCard`: summary, steps, checklist, source citations, expiry.
- `DenialCard`: denied rule and audit ID; no secret content.
- `DependencyChangeCard`: changed contract and source commit.
- `PlanDiffCard`: original vs revised steps and affected files.
- `OperationStatusCard`: queued/running/input required/error and retry when allowed.
- `CompletionCard`: tests, checkpoint commit, closed artifacts.

### 18.5 Frontend state rules

- Fetch one snapshot on entry.
- Poll every ~900 ms only while the demo view is active and any Operation is non-terminal.
- Stop polling when the tab/view is inactive or all Operations are terminal.
- Disable a decision button immediately after submission.
- Re-render from the server snapshot after every mutation.
- Never optimistically mark an agreement, permission, replan, or task complete.
- Use server `allowedActions` to show buttons.
- Maintain a visible “acting as Alice/Bob” demo switch; label it as mock identity.
- Display provider labels honestly.

### 18.6 Frontend files

Modify:

- `apps/web/src/types.ts`
- `apps/web/src/api.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`

Add:

```text
apps/web/src/telaegent/LandingPage.tsx
apps/web/src/telaegent/TelaegentApp.tsx
apps/web/src/telaegent/AgentRail.tsx
apps/web/src/telaegent/ConversationView.tsx
apps/web/src/telaegent/Composer.tsx
apps/web/src/telaegent/DetailDrawer.tsx
apps/web/src/telaegent/cards/IntentCard.tsx
apps/web/src/telaegent/cards/ConflictCard.tsx
apps/web/src/telaegent/cards/StatusCard.tsx
apps/web/src/telaegent/cards/ProposalCard.tsx
apps/web/src/telaegent/cards/ApprovalCard.tsx
apps/web/src/telaegent/cards/ToolCallCard.tsx
apps/web/src/telaegent/cards/PermissionCard.tsx
apps/web/src/telaegent/cards/ContextPackCard.tsx
apps/web/src/telaegent/cards/DependencyChangeCard.tsx
apps/web/src/telaegent/cards/PlanDiffCard.tsx
apps/web/src/telaegent/cards/OperationStatusCard.tsx
apps/web/src/telaegent/cards/AuditTimeline.tsx
```

### 18.7 Accessibility and polish

- All actions are real `<button>` elements.
- Cards have headings and readable labels, not color-only state.
- Keyboard focus is visible.
- Red/green decisions also use icons/text.
- Long file paths wrap.
- Loading states do not shift layout dramatically.
- Error cards include a recovery action only when the server allows it.
- Respect reduced motion.

---

## 19. Phoenix demo fixture

Seed a small TypeScript project requiring no external services:

```text
.telaegent/project.json
.env                         # dummy, ignored, never read by Telaegent
.gitignore
package.json
package-lock.json
tsconfig.json
docs/architecture/auth.md
src/auth/session.ts
src/auth/session-repository.ts
src/auth/fake-session-repository.ts
src/auth/redis-session-repository.ts
src/auth/oauth.ts
src/models/session.ts
src/models/user.ts
src/routes/login.ts
src/routes/oauth-callback.ts
tests/auth/session.test.ts
tests/auth/oauth.test.ts
```

Initial contract:

```ts
interface SessionRepository {
  create(input: { userId: string; deviceId?: string }): Promise<Session>;
}
```

Bob's later change:

```ts
interface SessionRepository {
  create(input: { userId: string; deviceId: string }): Promise<Session>;
}
```

Use fake `RedisClient` and `GoogleOAuthProvider` interfaces. Tests must be local and deterministic. No network, Redis server, OAuth secret, or browser callback is required.

Fixture initialization must:

1. Create Agents through `AgentService`.
2. Bind Alice/Bob/project/provider.
3. Copy the fixture while preserving Starter Kit workspace instructions.
4. Initialize Git, configure a demo-only local identity, and create a base commit.
5. Create the two feature branches/workspaces.
6. Run fixture tests.
7. Be idempotent or require an explicit safe reset.

---

## 20. Security and privacy design

### 20.1 Threat model for the prototype

Protect against:

- accidental or malicious `.env`/credential disclosure
- path traversal and symlink escape
- a model inventing permission
- prompt injection in shared source files
- stale or replayed approvals
- duplicate requests
- one Agent seeing another Agent's raw transcript/session
- concurrent writes to the same workspace
- Agent output that violates an active ownership agreement
- page refresh or process restart while a request waits
- secret-bearing errors or model output entering logs/UI

Do not claim protection against:

- a malicious local administrator
- compromised provider CLI binaries
- production multi-tenant attacks
- cryptographic owner identity
- secure deletion of provider-owned session files

### 20.2 Encryption answer

Be precise in the README and demo:

- **Browser ↔ server in the local demo:** loopback HTTP; not application-level encrypted. It does not leave the demo machine.
- **Server ↔ local CLI/container:** child-process stdio and local filesystem/container mounts, not a public message channel.
- **Remote deployment, if attempted:** terminate HTTPS/TLS at the deployment ingress. Never expose the API over plaintext public HTTP.
- **At rest:** the hackathon JSON store is not encrypted. Risk is reduced by persisting only safe structured coordination data and no credentials/raw transcripts.
- **Future production:** real identity, scoped tokens, HTTPS/mTLS as appropriate, encrypted database/storage, key rotation, and audit access control are required.

Do not build custom message encryption in 3–4 days; incorrect bespoke cryptography would add risk without improving the local demo.

### 20.3 Prompt-injection boundary

Approved source content is untrusted data. Context prompts must delimit it as quoted source and state that embedded instructions cannot change tools, policy, scope, or recipients. More importantly, enforcement remains outside the model:

- copied workspace contains no secrets
- run has read-only filesystem and no network
- tool dispatcher has no grant/approval capability
- output schema allows only ContextPack fields
- sources are revalidated against the trusted manifest

### 20.4 Audit event safety

Record:

- actor, operation, decision, rule, version, timestamp
- safe relative path or denied rule identifier
- source commit/digest
- status transition

Never record:

- denied file contents
- bearer tokens
- raw private prompts
- hidden reasoning
- full provider output

---

## 21. Edge cases and required behavior

| Edge case | Required behavior |
| --- | --- |
| Duplicate submission/retry | Return the original Operation through idempotency. |
| Two requests mutate one agreement | Atomic store mutation; second request gets stale version/invalid state. |
| Recipient has not replied | Persist `waiting_for_recipient`; show inbox card; requester can leave/reload; TTL continues. |
| Recipient replies after restart | Load waiting request and accept only if version/TTL/state remain valid. |
| Agent busy | Return `409 AGENT_BUSY`; leave request queued/retryable without starting a second run. |
| Agent offline/unavailable | Use latest checkpoint with `stale: true`; consequential automation pauses. |
| Provider missing/login expired | `RUNTIME_UNAVAILABLE`; safe setup hint, no raw stderr secrets. |
| Model returns malformed JSON | One schema repair attempt; then fail with `INVALID_AGENT_OUTPUT`. |
| Model invents a path | Policy validates actual normalized path; deny if unapproved. |
| Encoded traversal or Windows separator | Normalize both separator forms, reject traversal before resolution. |
| Symlink points outside root | Resolve target, deny before open/copy. |
| Approved file changes before pack | Commit/hash mismatch invalidates approval or pack; request refresh. |
| Pack has no sources | Reject. |
| Pack cites unapproved source | Reject. |
| Pack contains secret-like content | Reject or redact only when meaning remains safe; record safe reason. |
| Agreement proposal changes after one approval | Supersede old version and clear approvals. |
| One owner rejects | Never activate; state becomes rejected/revision required. |
| Three exchanges exhausted | Pause and create human escalation card. |
| Agent edits Bob-owned file | Reject checkpoint as ownership violation; do not mark complete. |
| Dependency change while Alice is running | Finish/cancel current atomic provider run safely, mark awaiting replan before next run. |
| UI loses connection | Snapshot reload reconstructs all cards and allowed actions. |
| Store lacks `telaegent` | Backfill empty shape without losing baseline data. |
| ContextPack expires | Remove from injectable context and mark expired; audit remains. |
| User requests hidden reasoning/transcript | Always deny; share only structured public summary/status. |

---

## 22. Testing strategy

### 22.1 Unit tests

Add:

```text
apps/server/src/telaegent/conflict-engine.test.ts
apps/server/src/telaegent/agreement-engine.test.ts
apps/server/src/telaegent/permission-engine.test.ts
apps/server/src/telaegent/context-policy.test.ts
apps/server/src/telaegent/context-pack-validator.test.ts
apps/server/src/telaegent/dependency-impact.test.ts
apps/server/src/telaegent/redaction.test.ts
apps/server/src/claude-code-runner.test.ts
```

Required cases:

- interface overlap produces score 5 in the demo
- unrelated tasks do not conflict
- model explanation cannot override score
- only exact/prefix path syntax accepted
- `.env`, `.env.local`, `.git`, traversal, absolute paths, secret names, and symlink escapes denied
- one approval does not activate a dual agreement
- both matching-version approvals activate
- rejection and proposal supersession behave correctly
- valid pack passes; missing/unapproved/stale/oversized/secret-bearing pack fails
- dependency change identifies Alice but not unrelated intent
- revised plan cannot take Bob-owned files
- redaction removes secrets without leaking originals
- Claude JSONL/session/final-result parsing works with fixtures
- Codex request gets correct schema/sandbox/session options

### 22.2 AgentService regression tests

- normal `sendMessage()` behavior unchanged
- internal middleware turn creates no public message
- raw prompt/output is absent from store
- correct provider selected
- busy lock applies across normal and middleware runs
- `fresh`/`ephemeral` session does not overwrite private persistent session
- restart cancels associated Operation safely
- sandbox and network mode reach the runner

### 22.3 Store tests

- old version-1 data loads with empty Telaegent state
- atomic concurrent decisions cannot both corrupt state
- event sequence is monotonic
- idempotency returns original record

### 22.4 Full Fastify integration test

Use deterministic `FakeCodexRunner` and `FakeClaudeRunner` to execute the entire flow through HTTP injection:

1. initialize
2. Bob task and progress
3. Alice plan
4. conflict
5. bounded status
6. proposal
7. separate approvals
8. Alice constrained implementation
9. context request
10. context approval
11. pack validation/delivery
12. `.env` denial
13. dependency change
14. impact and replan
15. replan approval
16. final implementation
17. completion and audit assertions

Assert runner call count, provider, sandbox, session mode, prompts absent from persistence, and exact state transitions.

### 22.5 Manual acceptance

- Fresh install on the demo machine
- Untouched Playground run
- One full Telaegent flow
- One real Codex run
- One real Claude run if credentials gate passed
- `.env` denial live
- Refresh browser while Bob approval is waiting
- Kill/restart server once in a rehearsal, not necessarily in the 3-minute demo
- `npm run check`
- `npm run poc` on supported environment

---

## 23. Deployment and reproducibility

### 23.1 Day 0 environment gate

On the final demo machine:

1. Confirm Node 22+, npm 10+, Git, and Docker where required.
2. Clone and run the untouched Starter Kit.
3. Configure ModelArk exactly as documented.
4. Run one normal Codex Agent turn.
5. Run one non-interactive Codex structured-output probe.
6. Check `claude` installation/authentication and run one structured-output probe.
7. Confirm the Phoenix fixture tests run without network.
8. Record exact versions in README.

If native Windows causes the official POC to fail, switch immediately to WSL2 or the designated Linux/macOS machine. Do not spend the event rewriting Bash/runtime scripts for Windows.

### 23.2 Local launch

Document the exact Starter Kit commands after cloning. The target experience is:

```text
npm install
configure required environment values
npm run check
npm run dev
open the displayed local URL
click “Initialize Phoenix demo”
```

Do not put real keys in the repository, screenshots, video, fixture, or audit data.

### 23.3 Prepared demo state

Because provider calls can be slow, implement a clearly labeled “Prepare demo checkpoint” or documented reset path that initializes the state immediately before Alice's conflict. This may seed **state already produced in rehearsal**, but it must not fabricate runtime success.

During the live demo:

- perform at least one genuine runtime operation
- perform the `.env` denial live
- clearly label prepared state
- never claim a fixture/fake result was generated live

### 23.4 Cloud

Cloud hosting is a post-freeze bonus only. If attempted:

- use existing Starter Kit deployment guidance
- require HTTPS
- do not expose CLI credentials in the browser
- do not add ECS work until local acceptance, README, video, and tests are complete

---

## 24. Four-day execution schedule

This schedule assumes five people working in parallel with hard integration gates. “Day 0” is the first 3–4 hours and must happen immediately.

### Day 0 — environment, contract, and cut line

Team outcomes:

- untouched Starter Kit green
- Codex live probe green
- Claude live probe green or honestly marked unavailable
- Phoenix fixture contract frozen
- `TelaegentEnvelope`, core records, permission matrix, tool schemas, error codes, and snapshot response frozen
- frontend wireframe frozen
- file ownership assigned

Individual work:

- Phuong: runtime probes and normalized runner contract
- Khoa: inspect actual store/service/app seams; freeze data/service transaction pattern
- Duy: freeze request/response schemas, states, permissions, errors
- Thai: create Figma/paper wireframe or direct component skeleton based on frozen snapshot
- Hien: freeze tool schemas, source policy, Phoenix fixture tree, test sequence

Exit gate: every person can paste their personal `.md` into their coding agent without contradictory interfaces.

### Day 1 — first vertical slice with fake runners

Morning:

- Phuong: provider selection, Claude adapter parser, AgentService middleware seam
- Khoa: Telaegent data backfill, service skeleton, Operations, snapshot, routes
- Duy: Zod schemas, conflict/permission/agreement engines
- Thai: landing shell, product shell, conversation renderer, polling API
- Hien: Phoenix fixture, Git helper, tool dispatcher skeleton, fake runners

Afternoon:

- Integrate: initialize → Bob message → Bob intent → Alice message → Alice intent → deterministic conflict → visible cards.
- All backend work uses fake runners first.
- Freeze response shape for frontend by 14:00.

Evening gate:

- one HTTP integration test reaches conflict
- browser displays both intents and conflict from real server state
- baseline Playground tests still pass

### Day 2 — coordination, approvals, and ContextPack

Morning:

- Phuong: structured status/proposal runs, session continuation, sandbox/session tests
- Khoa: Agent loop pause/resume, agreement transaction, waiting recipient flow
- Duy: version-pinned dual approvals, request edge cases, error mapping
- Thai: status/proposal/dual approval/permission cards and owner switch
- Hien: context policy, isolated source workspace, pack validator, `.env` denial

Afternoon integration:

- conflict → status → proposal → Alice approval → Bob approval → active agreement
- Alice constrained implementation
- context request → Bob approval → isolated pack → delivery
- `.env` denial

Evening gate:

- full flow through ContextPack passes with fake runners
- one real provider planning/status run passes the schema
- raw prompts and denied content are absent from JSON store

### Day 3 — dependency adaptation, real runtime, robustness

Morning:

- Phuong: live Codex/Claude integration, cancellation, provider error normalization
- Khoa: dependency/replan/completion orchestration and restart reconciliation
- Duy: stale/expiry/idempotency/exchange-limit tests
- Thai: dependency card, plan diff, completion, audit drawer, error/recovery UI
- Hien: dependency impact, ownership diff validation, full integration fixture

Afternoon:

- Execute full 17-stage fake-runner integration test.
- Execute the real provider flow in Phoenix.
- Fix only P0 defects.
- Run `npm run check` repeatedly.

Evening gate:

- canonical flow complete end-to-end
- at least one real code/test checkpoint
- `.env` denial proven
- README setup draft and architecture diagram ready
- no P0 TODO remains

### Day 4 — freeze, polish, rehearse, submit

Morning:

- fresh clone/setup on demo machine
- final responsive/accessibility pass
- failure-state evidence
- exact versions and limitations in README
- one-page architecture diagram

Afternoon:

- rehearse three-minute demo at least three times
- record backup video
- capture screenshots
- final `npm run check` and `npm run poc`
- tag/freeze submission commit

No architecture or schema changes on Day 4 unless the demo is broken.

### If only three days are available

Move required submission work into Day 3 evening and cut in this order:

1. landing animations and secondary sections
2. SSE/WebSocket experiments
3. browser E2E automation
4. live Claude demo if credentials/runtime remain unstable; retain adapter fixture tests
5. rejected-agreement UI polish
6. restart UI polish

Never cut conflict detection, separate approvals, ContextPack isolation/validation, `.env` denial, dependency replan, audit, or the full integration test.

---

## 25. Work division summary

Detailed self-contained assignments are in `phuong.md`, `khoa.md`, `duy.md`, `thai.md`, and `hien.md`.

| Person | Primary ownership | Coworker workstream |
| --- | --- | --- |
| **Phuong** | Codex/Claude runtime adapters, AgentService execution seam, async provider lifecycle and transport/runtime security | #1 plus runtime half of #5 |
| **Khoa** | Backend lead, store/data model, Telaegent service, Operations, conversation loop, waiting/resume/restart, shared memory, integration | #4 plus orchestration half of #5 |
| **Duy** | Versioned request format, Zod schemas, permissions, state machines, agreement/conflict rules, API errors and protocol tests | #2, paired tightly with #6 |
| **Thai** | Landing, product shell, conversation UI, approval/permission/artifact/plan cards, polling and demo UX | #3, independently consuming frozen APIs |
| **Hien** | Tool-call schemas/dispatcher, context source policy/isolation/validation, Git/Phoenix fixture, dependency impact, security and E2E tests | #6, paired tightly with #2 |

### 25.1 Required collaboration pairs

**Runtime/system pair: Phuong + Khoa**

- Freeze `MiddlewareRunRequest`, `NormalizedRunResult`, session behavior, and Operation lifecycle on Day 0.
- Phuong owns runner/provider mechanics.
- Khoa owns when/why a run starts, pauses, resumes, fails, or persists.
- Neither changes the shared seam alone after Day 1 noon.

**Protocol/tool pair: Duy + Hien**

- Freeze `TelaegentEnvelope`, tool names, tool argument schemas, permission classes, and errors on Day 0.
- Duy owns external/validation contracts and state rules.
- Hien owns execution, source isolation, and tool-specific security.
- Every tool schema needs one Duy validation test and one Hien execution/security test.

**Frontend contract: Thai consumes Khoa/Duy output**

- Thai gets a committed snapshot fixture by Day 1 noon.
- Backend preserves that shape; additive changes only after freeze.
- Thai never duplicates policy in React.

### 25.2 Integration ownership

Khoa is integration lead and final merge gatekeeper. This means resolving interfaces and sequencing merges, not rewriting other owners' modules.

Merge order:

1. Duy: core types/schemas/constants
2. Khoa: store/service/routes skeleton
3. Hien: tools/policy/fixture
4. Phuong: runtime/AgentService seam
5. Thai: frontend against frozen snapshot
6. Whole-team integration fixes

---

## 26. Team operating procedure

### 26.1 Branches

Use short-lived branches:

```text
feat/runtime-providers
feat/backend-orchestrator
feat/protocol-permissions
feat/frontend-conversation
feat/tools-context-fixture
```

Rebase/merge according to the team's chosen Git policy, but never force-push shared work without agreement.

### 26.2 Daily rhythm

- 09:00: 15-minute state/schema blocker sync
- 13:00: first integration window
- 18:00: second integration window and `npm run check`
- 21:00: end-to-end demo rehearsal from current main branch

Outside these windows, avoid touching another person's files.

### 26.3 Pull request checklist

- What user-visible stage does this unlock?
- Which state transitions changed?
- Which schemas changed?
- Are changes backward-compatible with the frozen snapshot?
- What sensitive data could enter persistence/UI?
- Which tests prove policy/state behavior?
- Does normal Playground behavior still pass?
- Is there a safe failure/error message?

### 26.4 AI coding-agent rules

When giving a personal file to a coding agent:

- tell it to inspect actual Starter Kit code before editing
- ask it to keep changes in assigned files
- ask it to preserve public contracts verbatim
- require focused tests and `npm run check`
- require a summary of assumptions and integration needs
- do not ask multiple coding agents to edit `types.ts`, `store.ts`, `App.tsx`, or `agent-service.ts` concurrently

---

## 27. Demo script

Target: 3 minutes.

### 0:00–0:20 — problem and product

Show the minimal landing view.

> “Two employee-owned coding agents can touch the same repository, but they should not share private memory or make commitments for their owners. Telaegent is the coordination and trust layer between them.”

Click `Launch Phoenix demo`.

### 0:20–0:45 — real Agents and intent

Show Alice and Bob, owners, providers, workspaces, and branches. Use the prepared checkpoint after Bob's first real run if needed. Submit Alice's OAuth task.

### 0:45–1:10 — conflict and agreement

Show score 5, Bob's bounded status, and the proposed work split. Approve once as Alice and once as Bob. Emphasize that the proposal activates only after both decisions.

### 1:10–1:45 — permissioned context

Show Alice asking for Redis architecture context. Switch to Bob, inspect the exact path scope and purpose, approve once, generate the pack, and show its source citations.

Immediately request `.env` and show the deterministic denial before access.

### 1:45–2:25 — adaptive Agent loop

Publish Bob's `deviceId` contract change. Show that Alice is detected as affected. Display the original/revised plan, approve as Alice, and resume.

### 2:25–2:50 — completion evidence

Show changed files, tests, checkpoint commit, expired task-only ContextPack, and audit sequence.

### 2:50–3:00 — close

> “Telaegent does not replace human teamwork. It lets separately owned agents coordinate routine details while people retain ownership, privacy, and authority.”

---

## 28. Risk register and mitigation

| Risk | Earliest signal | Mitigation | Owner |
| --- | --- | --- | --- |
| ModelArk/Codex setup fails | Day 0 probe | Stop feature work until baseline is green; use documented supported environment. | Phuong |
| Claude Code is unavailable | Day 0 probe | Keep adapter fixture-tested; demo two Codex Agents and label honestly. | Phuong |
| Native Windows incompatibility | `npm run poc` fails | Move to WSL2/Linux/macOS immediately. | Phuong |
| Model output is malformed | Schema test/live probe | Provider output schema + Zod + one repair only. | Duy |
| Agent loop becomes slow | Day 1 timings | `202` Operations, polling, prepared checkpoint, max steps. | Khoa |
| Secret leaks through source/output | Policy tests | Pre-open deny, isolated workspace, no network, validator, redaction. | Hien |
| Store state corrupts | Concurrent approval test | Reuse queued atomic mutation and version checks. | Khoa |
| UI invents/gets ahead of state | Day 1 integration | One snapshot and server-provided `allowedActions`. | Thai |
| Branch ownership is violated | Git diff test | Validate before checkpoint/completion. | Hien |
| Team merge conflicts | First integration | Strict file ownership and two fixed integration windows. | Khoa |
| Scope expands | New dependency/feature request | Apply P0/P1/cut list; no architecture changes after Day 3. | Everyone |

---

## 29. Final submission checklist

### Product

- [ ] Full canonical flow works.
- [ ] Agent loop is visible inside the conversation.
- [ ] Separate human approvals are undeniable in the UI.
- [ ] ContextPack has real source evidence.
- [ ] `.env` denial happens before access.
- [ ] Dependency change produces an explicit plan delta.
- [ ] Audit history is safe and complete.

### Engineering

- [ ] Baseline Playground still works.
- [ ] Codex adapter works live.
- [ ] Claude adapter is live or honestly fixture-tested/unavailable.
- [ ] No runner bypasses `AgentService`.
- [ ] JSON store migrates old data safely.
- [ ] No raw prompt/transcript/secret in database or UI.
- [ ] Unit and full integration tests pass.
- [ ] `npm run check` passes.
- [ ] `npm run poc` passes on the demo environment.

### Reproducibility

- [ ] README includes exact prerequisites, setup, providers, limitations, and demo steps.
- [ ] `.env.example` contains names only, no values.
- [ ] Fresh clone is rehearsed.
- [ ] One-page architecture diagram is included.
- [ ] Three-minute video is recorded as backup.
- [ ] Prepared state is clearly labeled.

### Story

- [ ] Explain why same project does not mean same unsafe working directory.
- [ ] Explain why shared memory is structured and bounded.
- [ ] Explain the real encryption limitations honestly.
- [ ] Say “A2A-inspired,” not A2A-compliant.
- [ ] Say model proposes; deterministic code authorizes and humans approve.

---

## 30. References used for these decisions

- Canonical local product specification: `TELAEGENT_PRODUCT_FLOW.md`
- Starter Kit repository: [RrankPyramid/CodeJam](https://github.com/RrankPyramid/CodeJam)
- Landing-page visual reference: [Grok Bot](https://x.ai/bot)
- Agent memory reference supplied by the team: [Hermes Agent persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- Codex non-interactive/runtime reference: [Official Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- Claude runtime reference: [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
- Stateful Agent request concepts: [A2A protocol specification](https://a2a-protocol.org/dev/specification/)
- Tool consent and visible invocation guidance: [MCP tools specification](https://modelcontextprotocol.io/specification/draft/server/tools)
- Agent action/observation loop: [ReAct paper](https://arxiv.org/abs/2210.03629)
- Memory-tier rationale: [MemGPT paper](https://arxiv.org/abs/2310.08560)
- Agent/tool security: [OWASP LLM Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)

These references justify selected design patterns; they do not add scope beyond the P0 plan.
