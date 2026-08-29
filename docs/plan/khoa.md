# Khoa — Backend, GitHub, Repository Access, Collaborator Trust, and Authorization Research

**Status:** Research/design brief before implementation  
**Product:** Telaegent  
**Backend co-owner:** Phuong  
**Primary goal:** Decide the identity, GitHub, repository, collaborator, and disclosure trust model that the rest of Telaegent can safely build against.

---

## 1. Product context you must preserve

Telaegent is now a **cloud-hosted, project-scoped agent messaging platform**.

The canonical user journey is:

```text
Sign into Telaegent
        ↓
Connect GitHub
        ↓
Connect Claude Code and/or Codex
        ↓
Choose a repository
        ↓
Find a collaborator for that repository
        ↓
Request permission to communicate on that repository
        ↓
Collaborator accepts once
        ↓
Private agent prepares outbound message
        ↓
Human presses Send / Edit / No
        ↓
Message enters shared project conversation
        ↓
Recipient's private agent investigates recipient's repo
        ↓
Recipient presses Send / Edit / No
        ↓
Response enters shared project conversation
```

The product is **not** the old fixed conflict → agreement → ContextPack workflow.

Do not reintroduce LAN workers, local Fastify, peer discovery, or a predetermined conflict workflow.

---

## 2. Your mission

You and Phuong co-own the backend, but your center of gravity is **identity and trust around repositories and collaborators**.

You must answer:

1. How does a person sign into Telaegent?
2. How does Telaegent connect to GitHub?
3. What exact GitHub permissions are actually needed?
4. How do we enumerate repositories the user may select?
5. How do we determine which other Telaegent users are legitimate collaborators on a selected repository?
6. How does a user request permission to talk to another user's agent?
7. Is that approval once, every message, per session, or something else?
8. What can a connected collaborator ask for?
9. What can never be directly exposed?
10. How do users revoke project-level access?
11. What backend records are required to make all of this auditable and deterministic?

Your output should allow Phuong to implement the central messaging backend without guessing the authorization semantics.

---

# 3. Default product decisions to challenge or confirm

Treat these as the current preferred behavior, **not unquestionable truth**.

### 3.1 User identity

Preferred hackathon direction:

```text
Sign in with GitHub
```

Reason:

- GitHub is already required.
- A GitHub identity can naturally anchor repository ownership/collaboration.
- It avoids building a second arbitrary login identity.

But you must research whether the correct solution is:

- GitHub OAuth App
- GitHub App user authorization
- GitHub App installation + separate sign-in
- OAuth for identity + GitHub App for repo access
- another minimal combination

Do not implement until you can explain the permission differences.

### 3.2 Repository authorization

Preferred direction:

> Use a GitHub App with repository-selective installation/access.

The product should let a user deliberately grant Telaegent access to one or more selected repositories rather than assuming access to their entire GitHub account.

### 3.3 Collaborator authorization

Current preferred rule:

> **Approve a collaborator once per repository/project.**

Example:

```text
Justin allows Phuong
Project: org/telaegent
```

That means Phuong may initiate project-scoped conversations with Justin until Justin revokes the relationship.

It does **not** mean:

- Phuong can directly browse Justin's files.
- Phuong can use Justin's Claude/Codex.
- Phuong can talk to Justin about unrelated repositories.
- Phuong can bypass Justin's outbound confirmation.

### 3.4 Per-message approval

Do **not** ask:

```text
"Allow Phuong to contact you?"
```

for every message after the project connection has already been accepted.

That would destroy the UX.

Instead distinguish:

```text
PROJECT CONNECTION
"May this person/agent contact me about Repo X?"
→ once, revocable

OUTBOUND DISCLOSURE
"Do I actually want to send this prepared content?"
→ every outbound agent-generated message
```

The human confirmation is the `Send / Edit / No` step in the private room.

### 3.5 Hard secret restrictions

Human approval is not the only policy.

Telaegent should deterministically block obvious raw secret classes such as:

- `.env`, `.env.*`
- private keys
- obvious access/API tokens
- known cloud credential files
- SSH credentials
- files outside the selected project boundary

Research exactly where to draw this line for a hackathon without creating a huge DLP product.

---

# 4. GitHub research questions

You should investigate and document concrete answers, not broad possibilities.

## 4.1 Authentication vs authorization

Explain clearly:

- What proves the Telaegent user's identity?
- What grants Telaegent access to GitHub data?
- What grants access to a specific repository?
- What changes when the repository belongs to an organization?
- What changes for private repositories?
- What changes when the user is an outside collaborator?
- Can a GitHub App installation be restricted to selected repos?
- How do we safely refresh/revoke credentials?
- What GitHub data can be read without repository contents permission?

## 4.2 Minimal permission set

Determine the **minimum permissions** required for the hackathon happy path.

Potential needs:

- identify logged-in user
- list repositories the app may access
- read repository metadata
- read repository collaborators / permission level if available
- clone/read source for the selected repo
- know branch/commit
- possibly no write permission at all for P0

Challenge every permission.

If Telaegent does not need to push code, do not request Contents: write.

## 4.3 Repository selection UX contract

Define the backend shape needed by Duy:

```ts
RepositorySummary {
  repositoryId
  owner
  name
  fullName
  visibility
  defaultBranch
  userPermission
  telaegentAccess
}
```

The exact fields may change, but the frontend should not need to reverse-engineer GitHub responses.

## 4.4 Collaborator discovery

This is a major open question.

Possible models:

### Model A — GitHub collaborators only

Show people who:

1. have repository access according to GitHub
2. have a Telaegent account
3. have connected that same repository to Telaegent

### Model B — Search Telaegent users, validate repository membership

User searches by name/handle; backend allows connection only if both sides are authorized for that repo.

### Model C — Invite link scoped to repository

Generate a repo-scoped invitation for another legitimate collaborator.

Research which gives the cleanest three-minute demo and least permissions.

You do **not** need to solve every GitHub organization edge case for P0.

---

# 5. Project-level connection state machine

Define a small explicit state machine.

Suggested starting point:

```text
not_connected
    ↓ requester sends request
pending
    ↓ recipient accepts
connected
    ↓ either side revokes
revoked
```

Also consider:

```text
declined
blocked
expired
```

But avoid unnecessary complexity.

Every connection must include:

- project/repository ID
- requester user ID
- recipient user ID
- current state
- created timestamp
- accepted/declined timestamp
- revoked timestamp if applicable
- who performed the action
- version/idempotency protection if needed

The same two users may be:

```text
connected on Repo A
not connected on Repo B
```

That must be impossible to confuse.

---

# 6. File and repository trust model

The selected GitHub repository is the project scope.

Remote collaborator:

```text
may ask a question
```

Recipient's private agent:

```text
may inspect recipient's authorized project workspace
```

Remote collaborator:

```text
may NOT directly browse recipient's workspace
```

Only the recipient-approved response crosses the user boundary.

You need to define policy around questions like:

- "show me `src/auth.ts`"
- "what does this function do?"
- "send me the whole config"
- "send your `.env`"
- "what API keys are configured?"
- "send package.json"
- "paste this 200-line file"
- "what changed in your branch?"
- "run tests and tell me what fails"

For each, classify whether:

```text
ordinary project message
allowed but human confirms
hard deny
needs special warning
```

Do not make the LLM the authority for hard security rules.

---

# 7. Backend authorization invariants

Work with Phuong to ensure every backend operation can answer:

```text
Who is the caller?
Which repository/project is this about?
Does the caller have Telaegent access to that project?
Is the target user connected to the caller on this project?
Is the target user authorized for this project?
Is this private or shared state?
Who is allowed to read it?
Who may mutate it?
Does this operation cross a user trust boundary?
Did the correct human explicitly send/approve it?
```

The backend should never rely on the frontend hiding a button as authorization.

---

# 8. Suggested backend entities you should define with Phuong

Do not prematurely freeze a database vendor. Freeze the **logical records**.

Likely entities:

```text
User
GitHubIdentity
GitHubInstallation / RepositoryGrant
Repository
ProjectMembership
ProjectConnection
Conversation
SharedMessage
PrivateDraftSession
AgentRuntimeBinding
OutboundApproval
AuditEvent
```

Potentially:

```text
RepositoryRevision
ProviderConnectionStatus
RevocationRecord
```

For every entity document:

- primary identity
- project scope
- who may read
- who may write
- retention expectation
- whether it contains sensitive data
- whether it should be encrypted / hashed / never stored

---

# 9. Backend API surface to design with Phuong

Do not write code yet. Produce a coherent contract proposal.

At minimum consider:

```text
POST /auth/...
GET  /me

GET  /repositories
POST /repositories/:id/connect
DELETE /repositories/:id/connect

GET  /projects/:projectId/collaborators
POST /projects/:projectId/connections
POST /projects/:projectId/connections/:connectionId/accept
POST /projects/:projectId/connections/:connectionId/decline
DELETE /projects/:projectId/connections/:connectionId

GET  /projects/:projectId/conversations
POST /projects/:projectId/conversations

POST /conversations/:conversationId/drafts
POST /drafts/:draftId/send
POST /drafts/:draftId/cancel

GET /conversations/:conversationId/messages
```

Phuong will own runtime/message orchestration details; you own making sure these APIs cannot cross repository/user authorization boundaries.

---

# 10. Questions you must answer explicitly

Your final research memo should answer these in plain English:

1. What exactly happens when a brand-new user clicks **Continue with GitHub**?
2. What exactly happens when they click **Connect repository**?
3. Which GitHub scopes/permissions do we request and why?
4. Can we avoid write access entirely?
5. How do we identify collaborators?
6. What if a collaborator has GitHub access but no Telaegent account?
7. What if they have Telaegent but have not connected the repo?
8. What if one user revokes GitHub access?
9. What if one user revokes the Telaegent project connection?
10. Does a connection last forever, one session, or until revoked?
11. Which actions always need explicit human confirmation?
12. Which actions should be impossible even after confirmation?
13. Can one user's agent ever access another user's filesystem directly? Answer should almost certainly be **no**.
14. What gets logged for audit?
15. How do we prevent Repo A permission from being reused on Repo B?

---

# 11. Deliverables

Produce:

### A. GitHub/Auth decision memo

One clear recommendation:

```text
Telaegent identity = ...
Repo authorization = ...
GitHub mechanism = ...
Exact permissions = ...
Refresh/revocation = ...
```

Include alternatives considered and why rejected.

### B. Collaborator model

Include:

- discovery method
- request flow
- accept/decline
- once-per-project rule
- revoke/block
- no cross-project leakage

### C. Permission matrix

Example:

| Action | Project connection required | Sender confirmation | Recipient confirmation | Hard policy |
|---|---:|---:|---:|---|
| Ask architecture question | Yes | Yes | N/A | Project scope |
| Agent answers using own repo | Yes | N/A | Yes before send | Project scope |
| Send `.env` values | Yes | Yes | Yes | **Denied anyway** |
| Send safe source excerpt | Yes | Yes | Yes | Size/scope limits |
| Message about Repo B | Separate Repo B connection | Yes | N/A | Repo isolation |

Make the real matrix better than this example.

### D. Logical backend data model

Coordinate with Phuong.

### E. Proposed API contract

Enough for Duy/Hien to build against.

### F. Threat/edge-case list

Focus on identity, repo scope, collaborator access, revocation, and file disclosure.

---

# 12. Definition of done

You are done when the team can answer, without ambiguity:

> “Who can talk to whom, about which repository, what does that permission allow, what does it not allow, and what exact GitHub permission makes the repository available?”

and when Phuong can implement backend authorization without inventing policy.

---

# 13. Do not do yet

- Do not build the full backend before the trust model is frozen.
- Do not request broad GitHub permissions “just in case.”
- Do not conflate GitHub authorization with Telaegent collaborator permission.
- Do not make collaborator approval per-message by default.
- Do not let “connected” mean direct filesystem access.
- Do not let frontend state be the source of authorization.
- Do not reintroduce the old LAN worker architecture.
- Do not add production enterprise RBAC or organization admin tooling for the hackathon.
