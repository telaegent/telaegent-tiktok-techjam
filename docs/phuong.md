# Phuong — Runtime Providers and Execution Lifecycle

This file is your self-contained implementation brief. Read `plan.md` and `TELAEGENT_PRODUCT_FLOW.md` before editing code. If this file and the master plan appear inconsistent, stop and resolve the contract with Khoa before implementation.

## 1. Mission

You own the connection between Telaegent and real coding Agents.

Your work covers coworker workstream **#1** and the runtime half of **#5**:

- connect Codex and Claude Code through one normalized runner contract
- keep the two Agents in separate workspaces/branches of the same logical repo
- support structured output and resumable private sessions
- enforce read-only vs workspace-write execution modes
- integrate with the existing `AgentService` busy/run/cancel/restart lifecycle
- expose safe provider availability
- normalize provider failures without leaking secrets

You do **not** implement coordination state, permission policy, frontend, ContextPack path authorization, or database memory.

## 2. Definition of success

Your work is done when:

- existing normal Playground runs behave exactly as before
- `AgentService` can run a private structured middleware turn through Codex
- the same method can target Claude Code when installed/authenticated
- both runners return one normalized result shape
- planning/status/context/replan runs cannot edit the Agent workspace
- implementation runs can edit only the assigned workspace
- a fresh/ephemeral ContextPack run does not attach to a persistent Agent session
- raw runtime prompts and unvalidated provider output are not saved as public messages
- one Agent cannot start a second concurrent normal or middleware run
- provider cancellation/restart updates the associated Operation through Khoa's callback/service seam
- capability detection never reveals paths, credentials, or raw stderr
- focused tests and `npm run check` pass

## 3. Files you own

Primary ownership:

```text
apps/server/src/agent-service.ts
apps/server/src/codex-runner.ts
apps/server/src/container-codex-runner.ts
apps/server/src/runner-factory.ts
apps/server/src/claude-code-runner.ts
apps/server/src/config.ts
apps/server/src/claude-code-runner.test.ts
```

You may add runner-focused test fixtures under the existing server test-fixture convention.

Do not edit without owner handoff:

- `apps/server/src/types.ts` — Duy owns the shared types
- `apps/server/src/store.ts` — Khoa owns persistence
- `apps/server/src/telaegent/**` — Khoa, Duy, or Hien owns these by responsibility
- `apps/web/**` — Thai owns frontend

When a shared type is missing, send Duy the exact type change rather than editing concurrently.

## 4. Contracts to freeze with Khoa on Day 0

Agree on these shapes before implementation:

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

interface NormalizedRunResult<T = unknown> {
  provider: AgentProvider;
  sessionId?: string;
  final: T;
  changedFiles: string[];
  exitCode: number;
  durationMs: number;
}
```

The provider runner must not know about agreements, ContextPacks, or human permissions. It receives a validated request and returns a normalized candidate.

## 5. Day 0 tasks — environment gate

1. Clone/run the untouched Starter Kit on the final demo environment.
2. Record Node, npm, Git, Docker, Codex, and Claude versions.
3. Run the baseline Playground flow.
4. Run a Codex structured probe using non-interactive JSON output and a tiny output schema.
5. Check Claude Code installation and authentication.
6. Run a Claude structured probe using print mode, stream JSON, and a JSON schema.
7. Report one of these statuses by the Day 0 deadline:
   - `codex_live_claude_live`
   - `codex_live_claude_adapter_only`
   - blocked with exact safe reason
8. Freeze the normalized request/result and lifecycle callback with Khoa.

Never paste authentication tokens or provider home contents into chat, commits, screenshots, logs, or test fixtures.

## 6. Implementation steps

### 6.1 Extend the runner boundary

- Preserve existing `AgentRunner` behavior for current callers.
- Add provider-aware optional fields rather than rewriting the full interface.
- Make defaults reproduce current Codex behavior.
- Use `execFile`/spawn argument arrays; never construct a shell command from model/user content.
- Add a hard timeout and output-size limit using current Starter Kit values.
- Capture stdout/stderr incrementally and bound both.
- Convert process exit, timeout, cancellation, parse failure, and auth failure into safe typed errors.

### 6.2 Codex runner

Required behavior:

- new session: stable non-interactive `codex exec`
- continued session: `codex exec resume <sessionId>`
- JSONL lifecycle output
- purpose-specific `--output-schema`
- `--sandbox read-only` for every non-implementation purpose
- `--sandbox workspace-write` only for `implement`
- working directory exactly equals validated Agent workspace
- no bypass/yolo option
- parse and return the provider session ID when supplied by events
- parse the final schema-valid result
- do not persist JSONL transcript

The current Starter Kit may already build some arguments. Refactor into a small pure `buildCodexArgs(request)` helper and unit-test it.

### 6.3 Claude Code runner

Implement a new runner with:

- `claude -p`
- `--output-format stream-json`
- `--json-schema <serialized-schema>`
- `--max-turns <bounded-number>`
- `--resume <sessionId>` only when `sessionMode === "continue"`
- explicit minimum tools/permission mode per purpose
- no permission bypass flag
- no forwarded subagent thinking/text
- no automatic browser/network tools for the demo

Permission profile intent:

| Purpose | Filesystem | Session | Network/tools |
| --- | --- | --- | --- |
| plan/status/proposal/replan | read-only | continue where required | read/search only |
| implement | workspace-write | continue | read/edit plus allowlisted local test commands |
| create ContextPack | isolated read-only copy | fresh/ephemeral | no network, no edit |

Do not rely only on Claude prompt instructions. The server/container boundary and allowed/disallowed tools must enforce the mode.

Write pure helpers:

- `buildClaudeArgs(request, schema)`
- `parseClaudeStreamLine(line)`
- `extractClaudeFinalResult(events)`
- `classifyClaudeFailure(error)`

Fixture tests must cover partial lines, irrelevant events, a valid final result, invalid JSON, timeout, missing session ID, and auth-like failure redaction.

### 6.4 Runner factory

- Select runner from the Agent's stored provider.
- Preserve the existing Codex default for old Agents.
- Return a typed unavailable result when Claude is missing.
- Do not silently fall back from a Claude Agent to Codex. Provider labels must be truthful.

### 6.5 `AgentService.runMiddlewareTurn()`

Implement this through existing Agent/run lifecycle primitives:

1. Validate Agent exists and is not busy.
2. Create an internal Run containing only `persistedSummary`, purpose, provider, and correlation ID.
3. Mark Agent busy.
4. Invoke the selected runner.
5. Keep raw prompt and output in local variables only.
6. Return the normalized candidate to Khoa's orchestration layer.
7. Persist only safe run status/error.
8. Update persistent provider session ID only for `continue` mode.
9. Mark Agent ready in success and failure paths.
10. Propagate a safe typed failure.

Normal Playground messages must not call this method unless Telaegent explicitly invokes it.

### 6.6 `sendVisibleCoordinatedMessage()`

This path is for Alice's real constrained implementation:

- public stored message is the original human task
- runtime prompt may contain active agreement, validated ContextPack, and plan revision
- runtime prompt itself is not stored in the message table
- final assistant output is redacted before persistence
- changed paths are reported for Hien's Git ownership check
- use the same busy lock and run lifecycle as normal messages

### 6.7 Container/network behavior

- Add per-request sandbox override.
- Add a network-disabled option for isolated ContextPack generation if the current container runner can apply it safely.
- Mount only the validated workspace.
- For an output schema stored outside the workspace, mount it read-only at a fixed container path.
- Preserve existing CPU, memory, PID, dropped-capability, and no-new-privilege limits.
- Never mount both Alice and Bob workspaces into one runtime.

### 6.8 Capability detection

Implement a safe service/helper consumed by Khoa's route:

```json
{
  "codex": { "installed": true, "authenticated": true, "reason": null },
  "claude": { "installed": false, "authenticated": false, "reason": "not_installed" }
}
```

- use short, non-destructive version/auth probes
- cache briefly so UI polling does not spawn repeated CLIs
- redact raw stderr
- never return binary/config/home paths

## 7. Lifecycle and unanswered-request collaboration with Khoa

Khoa owns the Operation state machine. You provide these signals:

- `onRunStarted(runId)`
- `onRunCompleted(runId, normalizedResult)`
- `onRunFailed(runId, safeError)`
- `onRunCancelled(runId)`

Required mapping:

- process running → Telaegent Operation `running`
- provider returns structured result → orchestrator validates before `completed`
- process cancelled/restart → Operation `cancelled` or `failed`
- provider waiting for interactive permission is a configuration defect; fail safely instead of hanging
- Agent busy → do not start provider; Khoa returns `409 AGENT_BUSY` or queues according to state

## 8. Tests you must write

### Runner argument tests

- Codex planning receives read-only and output schema.
- Codex implementation receives workspace-write.
- Codex resume uses only the owning session ID.
- Claude planning has no edit permissions.
- Claude ContextPack is fresh/ephemeral and network-disabled.
- Claude implementation has only intended tools.
- No bypass flag appears in any command.
- User text is a single argument/stdin payload, not shell-expanded.

### Parser tests

- valid Codex JSONL and final object
- valid Claude stream JSON and final object
- fragmented/blank/unknown events ignored safely
- oversized output stops
- timeout/cancel terminates process
- raw stderr is converted to safe error

### AgentService tests

- middleware run creates no normal messages
- raw prompt and raw output absent from serialized database
- busy lock shared with normal runs
- normal Playground behavior unchanged
- `fresh`/`ephemeral` session ID is discarded
- `continue` updates only that Agent's provider session
- restart/cancel releases busy state and notifies orchestrator

## 9. Daily deliverables

### Day 1

- normalized contract merged
- Claude runner parser and fake fixture tests green
- runner factory provider selection green
- `runMiddlewareTurn()` skeleton works with fake runner

### Day 2

- Codex structured status/proposal runs green
- private session continuation proven
- sandbox/session tests green
- one real provider planning run integrates with Khoa's loop

### Day 3

- live Codex implementation run in Phoenix
- live Claude run if gate passed
- cancellation/restart/error normalization complete
- capability endpoint data available
- all regression tests and `npm run check` green

### Day 4

- only demo-machine fixes, documentation, and rehearsal support
- no new runtime architecture

## 10. Required handoffs

To Khoa:

- final TypeScript contract
- lifecycle/cancellation behavior
- safe error taxonomy
- provider capability result
- example valid normalized results for every purpose

To Duy:

- any shared type additions needed in `types.ts`
- provider output schema constraints

To Hien:

- exact network/sandbox/session behavior for ContextPack
- changed-file result format for Git validation

To Thai:

- only the safe capability response via Khoa/Duy; never raw runner details

## 11. Do not do

- Do not implement Codex as a deprecated MCP server.
- Do not let Claude call Codex or Codex call Claude directly.
- Do not allow two Agents to edit one working directory.
- Do not add provider API SDKs when the Starter Kit already uses CLI runners.
- Do not use permission/sandbox bypass flags.
- Do not store complete JSONL streams.
- Do not silently switch providers.
- Do not expose provider credentials or filesystem locations.
- Do not add remote sidecars or cloud runtime work.

## 12. Final report format

When your coding agent finishes, require it to report:

1. files changed
2. exact public contract implemented
3. Codex live status
4. Claude live/adapter-only status
5. sandbox/session behavior
6. tests run and results
7. assumptions or unresolved integration needs

