# Thai — Frontend, Conversation UX, and Demo Presentation

This file is your self-contained implementation brief. Read `plan.md` and `TELAGENT_PRODUCT_FLOW.md` completely before editing.

## 1. Mission

You own coworker workstream **#3**: the complete visible product experience.

Build a polished but restrained frontend that makes Telagent's trust model obvious:

- premium dark landing view inspired by the compositional restraint of `x.ai/bot`
- Agent/owner/provider/machine/worker visibility
- the Agent loop inside one shared coordination conversation
- inline tool calls and results
- separate human approvals
- context permission and source evidence
- forbidden request denial
- dependency change and before/after plan
- operation progress and recovery
- audit history

You consume backend state; you do not implement permission or workflow policy in React.

## 2. Definition of success

Your work is done when:

- a judge understands the product in ten seconds from the landing view
- the full canonical flow can be followed top-to-bottom in one conversation
- every Agent action and observation has a visible card
- Alice and Bob approvals are visibly separate
- permission cards show purpose, exact paths, TTL, and stored/not-shared data
- `.env` denial clearly happens without exposing content
- source citations are visible on ContextPack
- original and revised plans are easy to compare
- queued/running/waiting/input-required/error states survive refresh
- each Agent clearly shows Computer A/B plus worker online, busy, stale, or offline state
- buttons come only from server `allowedActions`
- the existing Playground remains accessible and functional
- desktop demo is excellent and narrow layout remains usable
- frontend typecheck/build and `npm run check` pass

## 3. Files you own

```text
apps/web/src/types.ts
apps/web/src/api.ts
apps/web/src/App.tsx
apps/web/src/styles.css
apps/web/src/telagent/LandingPage.tsx
apps/web/src/telagent/TelagentApp.tsx
apps/web/src/telagent/AgentRail.tsx
apps/web/src/telagent/ConversationView.tsx
apps/web/src/telagent/Composer.tsx
apps/web/src/telagent/DetailDrawer.tsx
apps/web/src/telagent/cards/*.tsx
```

Do not edit server code. Ask Duy for types/fixtures and Khoa for route behavior.

## 4. Day 0 design deliverable

Create one wireframe covering:

1. landing hero
2. product shell
3. normal message
4. conflict card
5. proposal + separate approval card
6. context permission card
7. ContextPack card
8. denied `.env` card
9. dependency change + plan diff
10. operation/error state
11. audit drawer

Freeze the information hierarchy before visual polish.

## 5. Navigation without new dependencies

Do not add React Router. Use hash/location state:

- `#/` landing
- `#/demo` Telagent
- existing Playground reachable from a top-level view switch

Preserve Starter Kit Agent CRUD/lifecycle UI. If `App.tsx` is monolithic, extract the existing content carefully into a `PlaygroundView` only when necessary; avoid a large rewrite.

## 6. Landing view

Style direction:

- background around `#080909`
- off-white primary text
- subdued gray secondary text
- thin low-contrast borders
- one Telagent accent, preferably warm amber or electric teal
- large centered headline with strong line breaks
- concise paragraph, two CTAs
- product preview frame under hero
- small top navigation with product name and `Launch demo`
- subtle motion only after core is complete

Suggested content:

```text
Telagent

Agents can work together without oversharing.

Detect collisions, ask the right people, transfer only approved context,
and keep every decision auditable.

[Launch Phoenix demo] [See the coordination flow]
```

Do not copy xAI/SpaceXAI logos, typography assets, wording, or product imagery.

Time limit: half a day maximum.

## 7. Product shell

Desktop:

- left: Alice/Bob Agent rail with owner, computer, provider, worker status, branch, and progress
- center: shared coordination conversation and composer
- right: selected card details or audit timeline
- top: Telagent/Playground switch, Phoenix project, reset/init controls

Mobile/narrow:

- Agent rail becomes a top switcher
- detail drawer becomes bottom sheet/modal
- conversation stays primary

The demo uses a visible `Acting as Alice` / `Acting as Bob` switch. Label it “mock owner” so no one confuses it with production authentication.

## 8. API client

Implement typed functions for every public route in `plan.md`.

Minimum:

```text
initializeDemo
resetDemo
getRuntimeCapabilities
getWorkerStatus
getPhoenixSnapshot
getOperation
sendConversationMessage
continueIntent
requestStatus
requestProposal
decideAgreement
createContextRequest
decideContextRequest
generateContextPack
publishDependencyChange
requestReplan
decideReplan
completeIntent
```

API rules:

- centralize base URL, JSON parsing, and error envelope handling
- throw/display safe server message, code, correlation ID
- no raw HTML/error stack
- support `202 Operation` uniformly
- use `AbortController` for view unmount/replacement where useful

## 9. Snapshot-driven state

Use one authoritative `ProjectSnapshot` from Khoa/Duy.

Polling:

- fetch on entering demo
- poll approximately every 900 ms only while any Operation is non-terminal
- pause polling when document/view is inactive
- stop when no active Operation
- after a mutation, refresh immediately
- prevent overlapping polls
- handle network failure with non-destructive retry banner

Never optimistically mark approval, agreement activation, ContextPack delivery, replan approval, or completion. A button may show local pending/disabled state until the snapshot confirms the result.

## 10. Conversation renderer

Use a discriminated switch on `entry.type`. Unknown entries render a safe generic event card, not a crash.

Required cards:

### IntentCard

- owner + Agent + provider
- task
- branch/base commit short hash
- planned/changed files
- interfaces/dependencies
- progress/status

### ConflictCard

- score and level
- exact deterministic signals
- phrase “detected by policy”
- implementation paused state

### StatusCard

- state/progress
- changed files/interfaces
- last verified time
- fresh/stale badge

### Proposal/DualApprovalCard

- side-by-side Alice/Bob ownership
- dependency rules
- proposal version
- Alice decision and Bob decision separately
- Activate state only after server reports active
- reject button only for current acting owner/action

### ToolCallCard

- human-readable tool title
- safe arguments summary
- queued/running/completed/denied
- no hidden reasoning or raw prompt

### PermissionCard

- requester/recipient
- purpose/topic
- exact requested or approved path rules
- TTL/expiry countdown or timestamp
- risk/permission class label
- “Will store” and “Will not share” sections
- Approve once/Deny from `allowedActions`

### ContextPackCard

- topic/summary
- implementation steps/checklist
- sources with relative path and commit
- scope and expiry
- validated badge

### DenialCard

- blocked request (`.env` as path label only)
- deterministic rule ID
- statement that content was not read/shared
- audit event ID
- never render denied content

### DependencyChange/PlanDiffCard

- changed interface, change, source commit
- original and revised numbered steps
- affected files
- agreement-preserved indicator
- affected-owner approval

### CompletionCard

- test result
- changed files
- checkpoint commit
- ContextPack expiry/cleanup

### OperationStatusCard

- queued/running/waiting/input required/failed
- short safe explanation
- spinner only for active work
- retry/cancel only when server allows

## 11. Detail and audit drawer

Two tabs:

- `Details`: full selected card fields, source manifest, rules
- `Audit`: safe chronological events

Audit rows include actor, action, result, time, and correlation/audit ID. Do not parse prose to infer events.

Expected visible sequence:

```text
Bob published work intent
Alice published work intent
Conflict detected
Bob returned structured status
Resolution proposed
Alice approved
Bob approved
Alice implementation started
Context requested
Context approved
ContextPack validated and delivered
Forbidden context request denied
Bob changed Session contract
Alice's plan revised
Alice's implementation completed
```

## 12. Composer behavior

- Shows current acting owner/Agent.
- Disables while that Agent has a non-compatible active Operation.
- Provides two demo-friendly example prompts without automatically submitting them.
- On submit, keep user's original text visible.
- Internal policy/runtime prompt never appears.
- Enter submits; Shift+Enter makes newline if multiline.

## 13. Accessibility

- semantic buttons/headings/lists
- visible focus
- keyboard-operable drawer/tabs
- no state encoded only by color
- adequate dark-theme contrast
- `aria-live` for operation completion/failure, not constant polling noise
- reduced-motion support
- long paths and JSON-like content wrap/scroll safely

## 14. Loading/error/empty states

Implement explicit states for:

- not initialized
- initializing
- provider unavailable
- worker connecting, stale, offline, or token rejected
- empty conversation
- queued Agent run
- waiting for recipient
- human input required
- expired request
- invalid/stale decision
- server disconnected
- reset confirmation/result

Do not display a success state until it comes from the snapshot.

## 15. Work against fixtures first

By Day 1 noon, obtain from Duy/Khoa:

- a full `ProjectSnapshot` fixture
- one sample payload per conversation card
- `allowedActions` examples
- error envelope examples

Build all cards against this fixture while backend integration continues. Switch to real API the same afternoon.

## 16. Daily deliverables

### Day 0

- full wireframe/information hierarchy
- color/type/token decisions
- component map

### Day 1

- landing and product shell
- API/snapshot polling
- Agent rail, conversation renderer
- intent/conflict cards from real server

### Day 2

- status/proposal/dual approval
- tool/permission/ContextPack/denial cards
- owner switch and allowed-action wiring

### Day 3

- dependency/plan diff/completion/audit
- error/recovery/refresh behavior
- responsive/accessibility pass
- live full-flow integration

### Day 4

- visual polish, screenshots, demo rehearsal
- no new features

## 17. Tests and verification

At minimum:

- frontend typecheck/build
- manually render every card fixture
- unknown card type does not crash
- polling starts/stops correctly
- duplicate click prevented
- stale-version error shown safely
- refresh during waiting approval reconstructs UI
- Alice cannot see Bob-only action and vice versa
- buttons match `allowedActions`
- narrow viewport remains usable
- normal Playground remains usable
- `npm run check`

If the Starter Kit already has frontend test tooling, add focused component tests. Do not add a large E2E dependency if none exists.

## 18. Handoffs

From Duy:

- types and sample payloads
- state labels/error codes

From Khoa:

- routes, snapshot, allowed actions

From Phuong:

- safe provider capability and worker-lifecycle labels only

From Hien:

- source/denial/dependency payload examples

To the team:

- short screen recording by each evening gate
- exact demo click sequence
- any API mismatch immediately, not at end of day

## 19. Do not do

- Do not add a state library, router, Tailwind, or component framework.
- Do not recreate permissions in React.
- Do not show hidden reasoning, runtime prompt, raw JSONL, provider session ID, or denied content.
- Do not use fake success states in the judged path.
- Do not spend a full day on landing-page animation.
- Do not hide provider unavailability.
- Do not infer worker identity or online state in React; render Khoa's snapshot.
- Do not remove the Starter Kit Playground.

## 20. Final report format

Require your coding agent to report:

1. files/components changed
2. routes/types consumed
3. cards and states implemented
4. polling/refresh behavior
5. accessibility/responsive checks
6. build/test results
7. remaining API mismatches by owner
