# Agent intelligence layer — design

**Date:** 2026-09-01
**Owner:** Phuong (provider runtimes, sessions, connector, orchestration, Telaegent memory)
**Status:** Approved in chat; ready for implementation planning
**Horizon:** Hackathon submission. Every promise here must be demonstrable live on camera.

## 1. Problem

The safety layer works. 290 live turns produced no planted-secret leak — evidence
that the tested prompts did not leak, not proof that none can — the six protocol
invariants hold offline, and the connector reference monitor enforces containment
before any read. None of that is in question.

What does not work is the agent. It produces shallow drafts, misses the
`resourceRequests` ask on roughly one run in five, carries nothing between turns,
and never visibly demonstrates that it understood a permission boundary.

Those are four symptoms of one cause.

## 2. Diagnosis

**The turn budget is two.** `apps/server/src/index.ts:205` sets `maxTurns: 2`, and
`apps/server/src/authorization/authorized-private-runtime-turn.ts:162-164` caps
every purpose at 3. Claude receives `--max-turns 2` with `Read,Glob,Grep`. That is
one round of tool calls before the model must emit final JSON.

**Structured output competes for the same budget.** `--json-schema` is passed on
the same invocation, and the codebase already carries a workaround for what that
costs — `apps/server/src/claude-code-runner.ts:37-43`:

    /**
     * Older Claude Code releases can emit a valid structured object and then
     * keep calling StructuredOutput until the turn budget is exhausted.
     */
    export function completedStructuredOutputBeforeMaxTurns(...)

Turns spent on the output object are turns not spent reading. With a budget of two
there is nothing left over. `protocol/prompts/sender.ts` explicitly invites the
agent to read the owner's repository; the runtime then gives it no room to accept.

**Nothing writes memory.** `supabase-protocol-context-loader.ts:27` reads
`projectFacts` as up to 16 strings. Every RPC that produces it builds a fixed
four-element array of repository metadata — see
`supabase/migrations/20260901010000_protocol_context_claimed_drafts.sql:96`:

    'projectFacts', jsonb_build_array(
      'Repository: ' || project.repository_full_name,
      'Default branch: ' || project.default_branch,
      'Current branch: ' || coalesce(binding.current_branch, 'detached'),
      'Current commit: ' || binding.commit_sha
    )

That is identity the prompt already carries in `facts`. The learned-knowledge slot
exists, is wired end to end, and is filled with a restatement. Nothing in the
codebase has ever written a fact to it.

**Permission is prose.** `PERMISSION_BLOCK` describes the rules in paragraphs.
`guards.ts` is post-hoc and downgrade-only by design (invariant I5). The agent
guesses at its authority and is corrected by code the audience never sees.

## 3. What we are building

Three changes. None alters a security invariant.

### 3.1 Two-pass private turn

One logical turn becomes two provider invocations inside a single connector job:

    one connector job (owner's machine)
      pass 1  investigate   no --json-schema, --max-turns 12,
                            Read/Glob/Grep, read-only, network none
                            -> free-text research note, process memory only
      pass 2  draft         --json-schema, --max-turns 3, note in prompt
                            -> sender-turn / recipient-turn JSON
                            -> guards -> human approval

**Both passes run on the owner's machine, in one job.** This is a requirement, not
a preference. The canonical build plan lists "raw agent working context" and
"hidden reasoning" as private/local. The research note may quote any file the agent
read, secrets included. If the cloud orchestrated two jobs, that note would have to
enter cloud custody to reach pass 2. Keeping both passes in one
`connector-turn-executor` job means the note never leaves the machine, and the
cloud still receives exactly what it receives today: one schema-valid turn object.

**The turn cap becomes purpose-dependent.** A new `RunPurpose`,
`private_investigation`, joins `sender_draft` and `recipient_answer`. The policy
validator caps investigation at 12 and leaves the draft purposes at 3.

The security argument for opening the ceiling only there: the investigation pass
carries no output schema, so it cannot produce a `sendCandidate`. Its output is
structurally not a message. It has no ability to send, and everything it feeds
remains capped, guarded, and human-approved. The tight ceiling stays exactly where
outbound content is produced.

### 3.2 Durable project facts

The read path already exists. This adds the writer.

Both turn schemas gain an optional `learnedFacts` array — short factual statements
the agent believes are durably true about the project. Facts are persisted **only
from turns a human approved and sent**. Human approval already gates what crosses
between people; it now also gates what enters memory. A rejected draft teaches
Telaegent nothing.

A new `project_facts` table stores them per repository. The context RPCs union
derived metadata facts with learned facts, newest first, capped at the 16 the
loader already enforces.

### 3.3 Real grant list in the prompt

`list_task_capability_grants` shipped in migration `20260831100000`. The recipient
prompt gains a rendered block naming the resources currently granted for this task,
sourced from that RPC.

The agent stops guessing at its authority and starts reasoning from a real list.
This is what makes a refusal read as judgment rather than as our error handler. It
is a prompt input only — the grant list is still enforced deterministically by the
connector, and the guards still cannot be promoted by anything the model says.

## 4. Trust boundary change

One boundary widens, deliberately and narrowly.

Today progress events carry `activity: "tool"` and no target. The contract comment
in `runtime-contract.ts` is explicit: *"Deliberately excludes prompts, command
arguments, tool output, and model reasoning."* Model text is dropped at the
boundary, in `apps/server/src/connectors/connector-worker.ts:179`:

    if (event.type === "text_delta") return;

`activity_started` gains an optional `target: string`.

- Computed **by the connector**, never by the cloud.
- Produced with `projectRelativeDisplayLabel()`
  (`connectors/resource-exchange.ts:204`), which returns `null` for anything
  resolving outside the workspace. `src/auth/session.ts` crosses; absolute paths
  and anything outside the repository cannot, by the same containment check that
  already governs resource delivery.
- `text_delta` stays dropped. Model reasoning still never crosses. Only the name of
  a file inside the project does.
- Validated cloud-side by `progressSchema` in `connectors/routes.ts` reusing the
  existing `resourceDisplayLabelSchema` (`connectors/resource-request.ts:33`),
  which already caps at 512 chars and rejects control characters, backslashes, and
  absolute or drive-prefixed paths. No new validator is written for this.

This is what turns the investigation pass from dead time into the most convincing
twenty seconds of the demo: the audience watches the agent actually read the
codebase before it speaks.

## 5. Contract changes

| File | Change |
| --- | --- |
| `runtime-contract.ts` | `RunPurpose` gains `private_investigation`; `activity_started` gains optional `target` |
| `authorization/authorized-private-runtime-turn.ts` | Turn cap becomes purpose-dependent (investigation 12, draft 3) |
| `connectors/routes.ts` | `progressSchema` accepts `target` via `resourceDisplayLabelSchema` |
| `connectors/connector-worker.ts` | Emits `target` via `projectRelativeDisplayLabel()`; keeps dropping `text_delta` |
| `connectors/connector-turn-executor.ts` | Runs pass 1 then pass 2 in one job; the note never leaves the process |
| `telagent/protocol/contract.ts` | `learnedFacts` on both turn outputs; investigation prompt type; note char budget in `PROTOCOL_LIMITS` |
| `telagent/protocol/schemas.ts` | Zod parsers for `learnedFacts` |
| `telagent/output-schemas/*.json` | Regenerated — `protocol.test.ts` fails on drift |
| `telagent/protocol/prompts/` | New `investigate.ts`; grant block in `recipient.ts` |
| `telagent/protocol/memory.ts` | `rehydrationContext` consumes learned facts |
| `conversations/supabase-protocol-context-loader.ts` | Unchanged — the 16-fact cap already holds |

## 6. Database

One migration: `project_facts`.

    project_facts
      fact_id                  uuid primary key
      github_repository_id     text not null
      fact                     text not null
                                 check (length(fact) between 1 and 512)
      learned_from_message_id  uuid not null references the approved message
      created_at               timestamptz not null default now()

RLS mirrors the existing conversation tables — project membership only. The two
context RPCs are amended to union learned facts with derived metadata facts,
newest first, capped at 16. A companion `supabase/tests/` SQL test asserts the cap
and the membership boundary, matching the existing pattern.

## 7. Failure behaviour

| Failure | Behaviour |
| --- | --- |
| Pass 1 fails or times out | Pass 2 runs anyway with an empty note. Degrades to today's behaviour rather than failing the turn. |
| Pass 1 exhausts 12 turns | Whatever note it produced is used. `error_max_turns` is not an error here. |
| Note exceeds budget | Truncated to a fixed char budget before pass 2. Never persisted. |
| `learnedFacts` malformed | Turn still valid; facts dropped. Memory is best-effort, drafting is not. |
| Grant RPC unavailable | Recipient prompt renders without the grant block. Fails open on *prompt content* only — enforcement is unaffected. |
| `projectRelativeDisplayLabel` returns null | No `target` emitted. Progress event still sent as it is today. |

Nothing in this table can cause a message to be sent, a file to be read, or a grant
to be widened.

## 8. Testing

All offline. No live eval gate before the deadline.

- Turn cap is purpose-dependent; investigation cannot exceed 12; draft cannot
  exceed 3.
- An investigation request carrying an output schema is rejected at construction.
- The research note never appears in any cloud-bound payload — asserted on the
  connector job result, the progress stream, and the persisted draft.
- `target` is emitted for in-workspace paths and absent for escapes, traversals,
  and symlinks pointing out. Reuses the `resource-exchange` containment fixtures.
- `text_delta` is still dropped.
- Facts persist only from approved turns; a rejected draft writes nothing.
- Fact cap holds at 16 with learned facts crowding out derived ones.
- Corpus: paired should-investigate and should-not-investigate cases, per the
  `protocol/README.md` rule that a should-block case needs a should-proceed twin.

## 9. Out of scope

- **MCP tool surface.** Correct long-run answer, wrong thing to start days before a
  shoot: both CLIs need wiring, each tool needs its own security review, and it
  introduces a new failure mode between us and the camera. Sketch only.
- **Write capability.** P0 is read-only and stays read-only.
- **LLM summarisation of history.** `compactSummary()` stays deterministic.
- **Cross-project or cross-task memory.** Facts are scoped to one repository.
- **Any change to the six protocol invariants.**

## 10. Manual steps Phuong must perform

1. **Apply the migration** to Supabase — I cannot reach the project.
2. **Run the SQL contract tests** against the migrated database.
3. **Publish `@telaegent/connector` 0.1.10.** The two-pass logic ships in the
   connector. `npm publish -w @telaegent/connector` from the repo root, with an OTP
   if 2FA is on.
4. **Install 0.1.10 on both demo machines** before shooting. A machine left on
   0.1.9 runs the old single-pass turn, and the demo will silently look worse.
5. **Re-shoot Scene B** if it was already filmed — investigation changes the timing
   and should raise the `resourceRequests` hit rate above 4-in-5.

Nothing here requires a paid eval run.

## 11. Risks

**Latency roughly doubles per turn.** Mitigated by streaming pass 1 as visible
activity, which converts the wait into the demo's strongest proof. If streaming
does not land, the wait is real and unglamorous.

**Pass 1 reads secrets into the note.** By construction it may. The note stays on
the machine, is never persisted, and pass 2's output still passes
`looksLikeBareSecret()`, the guards, and the human. This does not create a new
disclosure path; it creates a new place a secret can sit in process memory for the
length of one turn.

**A raised ceiling is a real cost increase.** Twelve turns of read-only tool use
per investigation, per private turn. Bounded, but no longer trivial.

**`learnedFacts` is model-authored text entering durable storage.** It is rendered
inside the untrusted-data envelope like shared history, it is capped at 512 chars
per fact and 16 facts, and it is gated on human approval — but it is the first
model-authored content Telaegent stores durably. Worth naming plainly.
