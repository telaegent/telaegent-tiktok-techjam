# Duy — Complete Telaegent Frontend, Conversation UX, Private Agent Room, and Visual Product Design

**Status:** Product/UX design brief before implementation  
**Product:** Telaegent  
**Primary goal:** Make the entire product understandable in seconds and make the private-agent → human-confirmed → shared-message interaction feel obvious, safe, and memorable.

---

# 1. Product you are designing

### Architecture note: cloud product, local execution

The judged product requires a small local connector. GitHub CLI, the selected
repository/worktree, Claude Code/Codex, credentials, tools, and provider
sessions stay on the developer's machine. The browser and cloud control plane
show connector status and route bounded jobs; they never choose a local path or
run a provider CLI.


Telaegent lets:

> **my coding agent talk to your coding agent about a repository we both deliberately connected, while each human controls what their side sends.**

The frontend is not a dashboard for infrastructure.

It should feel like a modern messaging product with powerful coding agents underneath it.

The canonical flow:

```text
Landing
  ↓
Sign in
  ↓
Connect GitHub
        ↓
Run/connect local Telaegent connector
        ↓
Connect Claude Code / Codex
  ↓
Choose repository
  ↓
See project collaborators
  ↓
Request connection
  ↓
Recipient accepts
  ↓
Open shared project chat
  ↓
Type rough request
  ↓
Private side-chat with own agent
  ↓
Agent clarifies / prepares message
  ↓
Send / Edit / No
  ↓
Shared message
  ↓
Recipient's private agent investigates
  ↓
Recipient Send / Edit / No
  ↓
Shared response
```

That is your product story.

---

# 2. Visual direction

The landing page should take inspiration from the restraint of `x.ai/bot`:

- very clean
- premium
- dark or near-dark
- large simple typography
- minimal navbar
- one central product statement
- one obvious CTA
- product preview below
- subtle animation only if time permits

Do **not** copy xAI branding, wording, logo, or exact layouts.

Telaegent should feel like its own product.

Possible hero:

```text
Telaegent

Your agent can talk to my agent.

Connect your repo and coding agent.
Collaborate without manually copy-pasting context.

[ Get started ]
```

Alternative:

```text
Agents should be able to collaborate too.

Connect GitHub, Claude Code or Codex,
and open project-scoped agent conversations.

[ Start connecting ]
```

You should design and test the strongest wording.

---

# 3. Information architecture

The minimum top-level product areas are probably:

```text
Home / Projects
Project Chat
Connections / Requests
Settings / Connected tools
```

Avoid traditional admin-dashboard clutter.

A user should spend most of their time in:

```text
repository → collaborator → conversation
```

---

# 4. Onboarding

Design the exact first-run experience.

## Step 1 — Telaegent identity

Telaegent identity is handled through the cloud product, provisionally Supabase Auth.

Signing into Telaegent is conceptually separate from the developer's local GitHub CLI identity and repository proof.

## Step 2 — Local connector and GitHub proof

Current P0 direction is `telaegent connect .` (or equivalent) in the selected
local repository. The frontend should support a handoff/status flow such as:

```text
Connect this repository

Run locally:
telaegent connect .

Waiting for connector…
```

If local `gh auth status` fails, tell the user to authenticate GitHub CLI
locally and retry. Never imply Telaegent cloud stores that GitHub login.

After success:

```text
Local connector
✓ Online

GitHub
✓ Verified locally as @phuong

Repository
✓ telaegent/backend · feat/auth · 81ad2e
```

P0 may register one deliberately selected local repository at a time. A future
local picker may include repos accessible through ownership, collaboration, or
organization membership without uploading the whole list by default.

## Step 3 — Coding agent

```text
Connect your coding agent

Claude Code
[ Connect ]

Codex
[ Connect ]
```

Possible states:

```text
Not connected
Connecting…
Connected
Connector offline
Reconnect required
Unavailable
```

If both are connected:

```text
Default agent
(•) Claude Code
( ) Codex
```

Or let selection happen per project.

## Step 4 — Ready

```text
You're ready.

Choose a repository to start collaborating.
[ Continue ]
```

Do not turn onboarding into a 12-step settings wizard.

---

# 5. Project/repository picker

After onboarding:

```text
Your projects

┌────────────────────────────┐
│ telaegent/backend          │
│ 4 Telaegent collaborators │
│ Claude Code               │
└────────────────────────────┘

┌────────────────────────────┐
│ DueLook                    │
│ 1 collaborator            │
│ Codex                     │
└────────────────────────────┘
```

Clicking a repository enters the **project scope**.

Make the selected repository visible enough that users cannot accidentally think a conversation is global.

---

# 6. Collaborator discovery

Inside a project:

```text
telaegent/backend

Collaborators

Justin                 Connected
Khoa                   Connected
Thai                   Request
Hien                   Request
```

For a non-connected person:

```text
[ Request to talk ]
```

After request:

```text
Pending
```

Recipient sees:

```text
Phuong wants to connect agents
Project: telaegent/backend

This allows project-scoped messages.
It does not grant direct repository access.

[ Decline ] [ Accept ]
```

This explanation is important.

Once accepted:

```text
Connected on telaegent/backend
```

Do not repeatedly ask permission on every normal message.

---

# 7. Shared project conversation

This is the main product surface.

It should look familiar enough to messaging users while still making agent identity clear.

Example:

```text
┌──────────────────────────────────────────────────────────────┐
│ ← telaegent/backend          Justin             Claude ↔ Codex│
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ You                                                          │
│ Can you ask your agent how refresh token rotation works?     │
│                                                              │
│                               Justin's Claude                 │
│                               The current implementation...  │
│                                                              │
│                                                              │
│ [ Ask your agent to prepare a message... ]                   │
└──────────────────────────────────────────────────────────────┘
```

Possible message actor labels:

```text
You
Your Codex
Justin
Justin's Claude
Telaegent
```

Be careful: the shared chat should not expose private agent back-and-forth.

---

# 8. The signature interaction: private agent room

This needs the most design attention.

The user types a rough intention:

> `can u send me ur .env`

Do **not** send it directly.

Open a side panel/modal/floating window.

Example:

```text
┌─────────────────────────────────────────────────┐
│ Private with Codex                    [ × ]      │
│ Preparing message to Justin                       │
│ Project: telaegent/backend                        │
├─────────────────────────────────────────────────┤
│ Shared context                                    │
│ Last 6 approved messages…                         │
│                                                   │
│ You                                               │
│ can u send me ur .env                             │
│                                                   │
│ Codex                                             │
│ That likely contains credentials. Do you need     │
│ the values or only the variable names?            │
│                                                   │
│ You                                               │
│ only the names                                    │
│                                                   │
│ Codex                                             │
│ Ready to send:                                    │
│                                                   │
│ "Can you share the required environment variable │
│ names without any secret values?"                 │
│                                                   │
│                [ Edit ] [ No ] [ Send ]           │
└─────────────────────────────────────────────────┘
```

The UI must make clear:

```text
PRIVATE
not yet sent
```

versus:

```text
SHARED
visible to collaborator
```

This is the trust boundary and the hackathon wow moment.

---

# 9. Private room behavior

The agent can:

- ask clarification questions
- inspect the user's own project if relevant
- refer to recent shared conversation
- rewrite the request
- explain potential risk
- produce a send-ready candidate

Bound the UX.

The agent should not drag the user into a 20-turn conversation for a simple message.

Design statuses such as:

```text
Thinking
Needs clarification
Ready to send
Blocked by policy
Error
```

When ready:

```text
[ Edit ] [ No ] [ Send ]
```

Potential keyboard shortcuts if helpful:

```text
Enter — send clarification
Cmd/Ctrl+Enter — Send final candidate
Esc — close/cancel
```

But keep mobile usability.

---

# 10. Recipient-side experience

The recipient should see the approved incoming message in the shared chat.

Then their own agent can act.

Possible UX:

```text
Incoming request from Phuong

"Can you share the required environment variable
names without secret values?"

[ Ask Claude to handle ]
```

or automatically open/queue the recipient private room depending on product flow.

Recipient's private room:

```text
Claude
I checked this repository.

Safe response:
DATABASE_URL
REDIS_URL
JWT_SECRET
GOOGLE_CLIENT_ID

No values included.

[ Edit ] [ No ] [ Send ]
```

Only the final approved response appears in shared chat.

The two sides should feel symmetric.

---

# 11. Secret / sensitive content UX

Telaegent has deterministic hard restrictions for obvious secrets.

Design a clear state.

Example:

```text
Protected content

Telaegent won't send raw `.env` values.

Your agent can instead share:
• variable names
• safe configuration structure
• documentation

[ Ask agent to prepare safe alternative ]
```

Do not show raw secret values and then merely warn the user.

For less clearly sensitive source snippets, a warning could say:

```text
This response includes source code from your connected repository.

[ Review ] [ Send ]
```

Exact policy comes from Khoa/Hien.

---

# 12. Connection permission UX

Important default:

```text
connection approval = once per project
```

not every message.

Make that scope visible.

Connection card:

```text
Phuong wants to connect with you

Project
telaegent/backend

What this allows
✓ project-scoped messages
✓ their agent can ask your agent questions

What this does not allow
✕ direct access to your repo
✕ access to other projects
✕ messages sent from your side without your approval

[ Decline ] [ Accept ]
```

That card itself explains the product.

## 12.1 Scope-expansion approval

The connection card is the once-per-project decision. This is the smaller,
in-task one, and it is a screen only you can make safe.

[Canonical build plan section 8](../product/canonical-build-plan.md): when a
collaborator's agent needs a file the owner has not granted for this task, the
owner is asked. When the owner has already granted it, nothing is shown - the
request is served silently, which is the point.

```text
B's agent needs:
src/settings.ts

Reason:
"LandingPage.tsx imports configuration from this file."

Permission:
READ ONLY

[Deny] [Allow once] [Allow for this task]
```

Requirements:

- Name the exact file. Never a directory, a glob, or "some related files".
- Show the access level literally. P0 is read-only; there is no write option.
- The reason line comes from the requesting agent. Present it as a **claim**,
  not as a finding. Do not style it like a Telaegent statement of fact.
- **Allow once** serves this request only. **Allow for this task** adds that one
  file to the task's read-only scope, so later requests for it resolve without
  asking again. Say which one is which in the UI, not only in a tooltip.
- Say plainly that "for this task" covers later versions of that file until the
  task ends or the owner revokes.
- `Deny` must be a real answer, not a dead end. Show what the agent does next.

The three failure modes to design against:

1. **Approval fatigue.** If a task shows six of these, the owner stops reading.
   Batch related requests in one round rather than one prompt per file.
2. **Persuasion.** The reason text is agent-authored. A well-written reason must
   not make a broad grant feel routine.
3. **Invisible accumulation.** The owner needs a place to see what this task has
   been served and to revoke mid-task - see 12.2.

## 12.2 Granted-scope panel

Somewhere in the task or conversation view, the owner must be able to answer
"what has my side handed over for this?" without reading the transcript.

```text
Shared for this task

src/LandingPage.tsx   read-only   granted 2m ago     [Revoke]
src/settings.ts       read-only   granted just now   [Revoke]

Ends when this task ends.
```

Revoking must visibly stop future automatic service, and the copy should be
honest that it does not un-send what was already served.

---

# 13. Connected tools/settings

Simple settings:

```text
Account
GitHub @phuong

Repositories
telaegent/backend    Connected
DueLook              Connected
secret               Disconnect

Local connector      Online
Coding agents
Claude Code          Connected locally
Codex                Connected locally

Default
Claude Code

Security
Active project connections
```

Potential actions:

```text
Reconnect provider
Disconnect provider
Disconnect repository
Revoke collaborator
Sign out
```

Duy should design consequences/warnings, while backend behavior comes from Phuong/Khoa.

---

# 14. Memory UX

Telaegent's shared project chat is durable product memory.

Do not expose provider session IDs.

If a provider session is recreated, the user should ideally not care.

Possible subtle state:

```text
Claude context restored from Telaegent conversation
```

Only show if useful.

Do not make users manage "thread IDs."

---

# 15. Message metadata

Decide how much repo state to expose.

Potential compact metadata:

```text
Justin's Claude
branch: feat/auth
commit: 81ad2e
```

This can be useful when answers depend on repo version.

But too much metadata turns messaging into a debugger.

Design a hierarchy:

- normal chat = clean
- hover/detail = branch/commit/provider
- warnings when repo revisions differ significantly

Hien may find which metadata improves agent correctness.

---

# 16. Loading / real-time states

Agent calls are slow compared with normal chat.

Design:

```text
Preparing with Codex…
Waiting for Justin…
Justin's Claude is investigating…
Response ready for Justin's approval
Justin approved and sent
```

Do not pretend agent work is instant.

The user should always know:

- whose side currently has the turn
- whether something is private
- whether a human decision is pending
- whether the collaborator is offline/unavailable
- whether provider auth needs reconnection

---

# 17. Error states

Design explicit UI for:

- GitHub not connected
- local connector not installed/offline
- repository permission revoked
- collaborator not connected
- connection pending
- collaborator revoked access
- Claude/Codex reconnect required
- connector/provider unavailable
- agent timed out
- private draft failed
- send blocked by policy
- backend disconnected
- repo unavailable
- stale local repository metadata
- provider switched
- no eligible collaborators

Every error should tell the user what they can do next.

---

# 18. Landing-page product demo/preview

Below the hero, visualize the core flow.

Maybe a compact animation:

```text
YOU + CODEX                   JUSTIN + CLAUDE

"How does auth work?"
       ↓
 private draft
       ↓
     SEND
════════════════════ project ════════════════════>
                                      inspect repo
                                          ↓
                                      Justin reviews
                                          ↓
<════════════════════ SEND ═══════════════════════
"Tokens rotate after..."
```

The preview should communicate the idea without text-heavy architecture diagrams.

---

# 19. Mobile

The private side-room is especially important on mobile.

Potential pattern:

- shared chat full screen
- tapping composer opens private-agent bottom sheet
- bottom sheet can expand full screen
- send-ready candidate pinned above action buttons
- easy return to shared conversation

Do not rely on hover-only interactions.

---

# 20. Accessibility

At minimum:

- semantic buttons
- keyboard navigation
- visible focus
- labels beyond color
- high contrast
- screen-reader labels for private/shared state
- reduced motion
- send confirmation accessible without drag gestures
- long code/file paths wrap or scroll

---

# 21. Wireframes you must produce before coding

Create at least:

1. landing
2. sign-in/onboarding
3. provider connection screen
4. repo picker
5. collaborator list
6. outgoing connection request
7. incoming accept/decline card
8. empty shared conversation
9. active shared conversation
10. private drafting room
11. clarification turn
12. ready-to-send state
13. secret-blocked state
14. recipient private response room
15. provider reconnect error
16. project settings / revoke collaborator
17. mobile chat + bottom-sheet private room
18. scope-expansion approval prompt (`Deny` / `Allow once` / `Allow for this task`)
19. granted-scope panel with per-resource revoke
20. bounded-loop limit reached, and what the owner is offered next

---

# 22. API contract needs

Give Phuong/Khoa a frontend-oriented contract list.

You likely need data for:

```text
current user
connected GitHub account
provider statuses
repositories
project
collaborators
connection requests
conversations
shared messages
private draft/session state
pending human action
pending scope-expansion request
granted task scope, per resource, with revoke
runtime status
audit/security events
```

Do not invent backend authorization.

Use server-provided allowed actions/status.

---

# 23. Demo UX

Design the three-minute happy path:

### 0:00–0:20

Landing:

> "Your agent can talk to my agent."

### 0:20–0:40

Show connected GitHub + Claude/Codex and choose project.

### 0:40–1:00

Request Justin connection / show prepared accepted state.

### 1:00–1:40

Phuong types:

> `can u send me ur .env`

Private Codex asks clarification.

Phuong says only variable names.

Press Send.

### 1:40–2:15

Justin's Claude inspects repo privately and prepares safe answer.

It asks for one file it does not own. Phuong chooses **Allow for this task**.
A second request for the same file resolves with no prompt - say out loud that
the absence of a second prompt is the feature.

Justin presses Send.

### 2:15–2:40

Answer arrives to Phuong.

Show `.env` values were never shared.

### 2:40–3:00

Show project scope + different providers + connection is revocable.

That is probably enough. Do not overstuff the live demo.

---

# 24. Deliverables

Produce:

### A. Figma or equivalent full flow

Not just individual screens.

### B. Design system

- typography
- spacing
- dark/light decision
- accent
- card hierarchy
- private/shared states
- warning/error treatment

### C. Interactive prototype

Especially:

```text
shared composer
→ private room
→ clarification
→ send candidate
→ shared chat
```

### D. API/state requirements memo

For Phuong/Khoa.

### E. Mobile flow

### F. Three-minute click script

---

# 25. Definition of done

You are done when a person who has never heard of Telaegent can look at the product for ten seconds and understand:

> “I choose a repo, connect to a teammate, my agent privately helps me prepare something, I approve it, and their agent can privately investigate their side before they approve a response.”

without someone explaining the backend.

And, on the scope prompt specifically: an owner who has never read the trust
model can tell the difference between **Allow once** and **Allow for this task**
without being told, and can find what they have already granted.

---

# 26. Do not do yet

- Do not build an infrastructure dashboard.
- Do not expose provider session IDs.
- Do not show raw agent chain-of-thought.
- Do not send rough composer text directly to collaborator.
- Do not ask connection permission on every message.
- Do not let an agent name a file path in an approval prompt that the owner
  never granted a resource ID for; the owner approves a resource, not a string.
- Do not offer a directory, glob, or "and related files" grant.
- Do not offer a write grant in P0.
- Do not present an agent-written justification as a Telaegent finding.
- Do not hide which repository the conversation belongs to.
- Do not make "connected" look like direct filesystem access.
- Do not copy x.ai/bot branding.
- Do not add dozens of settings.
- Do not implement backend policy in React.
