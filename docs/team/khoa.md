# Khoa — Backend Co-Owner: Local GitHub Proof, Repository Access, Collaborator Trust, Authorization, and Capability Policy

**Status:** research/design before full implementation  
**Product:** Telaegent  
**Backend co-owner:** Phuong

## 1. Canonical architecture

Telaegent is cloud-hosted for coordination and uses a required outbound local connector for GitHub and provider execution.

```text
User A developer machine
├─ local GitHub CLI authenticated as User A
├─ User A's selected local repository/worktree
├─ locally authenticated Claude Code and/or Codex
└─ Telaegent connector bound to User A × repository
```

Claude/Codex do not need direct GitHub integration. They operate on the local files selected by the connector. The cloud never receives the workspace path.

A GitHub App is **not required for P0**.

## 2. GitHub connection hypothesis

First connection:

```text
Connect GitHub
→ connector checks the user's existing local GitHub CLI auth
→ if missing, user authenticates locally outside Telaegent
→ gh auth status
→ user selects one local repository/worktree
→ resolve stable GitHub repository ID
→ register safe metadata and an opaque connector binding
```

Candidate commands:

```bash
gh auth status
git remote get-url origin
git rev-parse HEAD
```

Critical caveat: the connector may inspect safe `gh` status/API output, but it
must never upload tokens, credential files, environment variables, or local
paths. Telaegent cloud never runs or relays `gh auth login`.

## 3. Repository discovery correction

Do not use only:

```bash
gh repo list
```

as "all repositories this user can work on."

Use the authenticated-user repositories API, which includes access through ownership, collaboration, and organization membership. It can be invoked through `gh api`.

Persist/use the stable GitHub repository ID.

Suggested DTO:

```ts
RepositorySummary {
  githubRepositoryId: string // canonical positive PostgreSQL BIGINT decimal
  fullName
  owner
  name
  visibility
  defaultBranch
  permission?
  connectedToTelaegent
}
```

## 4. Project creation

A repository becomes a Telaegent project only when:

1. Telaegent user is authenticated.
2. Their local GitHub identity can access the repository.
3. They deliberately select it.
4. Telaegent records the stable GitHub repository ID.
5. An opaque cloud connector binding is created; its local workspace mapping stays on the developer machine.

The cloud never clones the repository.

## 5. Collaborator discovery: mutual proof

Do not rely on one user enumerating all GitHub collaborators.

```text
Phuong connects repo ID 123
Justin connects repo ID 123
→ Telaegent independently proved both have access
→ they are eligible to discover/request each other
```

This is the preferred MVP collaborator model.

Potential privacy refinement: only show matched Telaegent users who opt into discoverability.

## 6. Project-scoped connection cadence

Connection approval is **once per project**, until revoked.

Connected means:

- may initiate project-scoped messages
- may ask the other side's agent project questions

Connected does not mean:

- direct filesystem access
- direct Claude/Codex access
- auto-send rights
- access to other repos
- private draft visibility

State:

```text
not_connected → pending → connected → revoked
pending → declined
```

## 7. Four separate authorization layers

1. Telaegent identity.
2. GitHub repository authorization.
3. Telaegent project connection.
4. Exact outbound disclosure approval.

Per-message human gate:

```text
[ Edit ] [ No ] [ Send ]
```

is different from collaborator connection.

A task-scoped capability grant sits under layer 4, never beside it. It can only
reuse authority the owner already gave for that task, and it never covers the
outbound message itself.

## 8. File/source access

Remote collaborator asks; recipient's own agent inspects the recipient's registered local repo.

```text
shared request
→ recipient private agent runtime
→ recipient repo checkout
→ prepare response
→ recipient Send/Edit/No
→ shared response
```

No remote filesystem API.

## 8.1 Task-scoped capability grants

[Canonical build plan section 8](../product/canonical-build-plan.md) adds a
narrowing of that rule, and the policy is yours to specify.

A remote agent still never names a file. It names an **opaque resource ID** the
owning connector issued earlier in the same task. The owner's side resolves the
ID, and a deterministic policy engine - not the model - decides.

Automatic service requires all six of:

```text
same task
same peer
same exact resource ID
read-only
grant not expired or revoked
canonical path resolves inside the registered project
```

Miss any one and the request becomes a scope-expansion prompt with
`Deny` / `Allow once` / `Allow for this task`. **Allow for this task** adds that
one resource to the task's read-only scope; it never adds a directory, a glob,
a sibling file, or write access.

The governing rule:

> An agent may consume or narrow authority a human already delegated. It may
> never autonomously broaden that authority.

What you own here: the grant record and its lifetime, how revocation and expiry
reach a connector that was offline when the owner revoked, whether a resource ID
survives a rename or delete, and the authorization checks below.

## 9. Hard policy

Hard-deny obvious raw secret classes:

- `.env`, `.env.*`
- API/access tokens
- private keys
- cloud credential files
- SSH credential material
- paths outside selected project
- another user's runtime/private drafts
- a resource ID from a different task, a different peer, or a different project
- any write, execute, or delete against a capability grant
- a resource ID whose canonical path leaves the registered project by traversal or symlink

The request "send me your .env" may enter the conversation, but raw `.env` values should not cross the trust boundary. Offer safe alternatives.

## 10. Telaegent user auth

Thai proposes Supabase Auth.

Decide with Thai/Phuong whether Telaegent account sign-in uses GitHub, email/magic-link, or another simple method.

If Telaegent login itself uses GitHub, label it clearly: Telaegent identity is still conceptually different from the developer's local GitHub CLI identity used to prove repository access.

## 11. Backend entities with Phuong

Freeze:

```text
User
GitHubConnection
Repository
ProjectMembership
ProjectConnection
Conversation
SharedMessage
PrivateDraftSession metadata
OutboundApproval
ProviderConnection status
AuditEvent
RuntimeBinding
```

For each define read/write scope, retention, sensitive fields, revocation.

## 12. Authorization checks

Every backend action must verify:

```text
authenticated user
project membership
repo ID
project connection
private-state ownership
target user
revocation state
capability grant: task, peer, resource, mode, expiry
```

Frontend button visibility is not authorization.

## 13. Critical experiments

1. Run `gh auth status` through the local connector without logging credential output.
2. Resolve the selected repository's normalized remote and stable numeric ID.
3. Register only safe owner/name/ID/branch/commit metadata.
4. Prove the cloud receives no local path, repository content, or credential.
5. Restart/reconnect the connector and recover the correct opaque binding.
6. Test private, organization, and collaborator-not-owner repositories.
7. Revoke local GitHub access and verify project suspension.
8. Prove Repo A never authorizes or resolves Repo B.
9. Replay a resource ID under a different task and peer and confirm both fail.
10. Revoke a task grant mid-task and confirm the next request stops being served.

## 14. Known flaws

### Local auth UX

If GitHub CLI is unauthenticated, show the exact local recovery instruction and
wait for a fresh connector check. Do not proxy an interactive login through the
cloud.

### Credential storage

The developer's local GitHub credential remains outside Telaegent custody.
Protect connector logs and job results from accidentally relaying it.

### Organization/SSO edge cases

Controlled demo accounts are fine for P0; document limitations.

### Repo synchronization

Freeze branch/clone/fetch/dirty-worktree behavior with Phuong.

## 15. Deliverables

- real local `gh` repository proof through the connector
- repo discovery recommendation
- Telaegent identity recommendation
- mutual-proof collaborator model
- once-per-project connection state machine
- file permission matrix
- capability grant model: issue, scope, expire, revoke, audit
- logical backend data model
- route authorization matrix
- revocation behavior
- threat/edge-case list

## 16. Do not do

- no GitHub App requirement for P0 unless experiments force it
- no `gh repo list` as universal repo picker
- no direct remote filesystem
- no collaborator approval every message
- no GitHub collaborator enumeration as sole discovery
- no Repo A → Repo B permission reuse
- no capability reuse across tasks or peers, and no write grants in P0
- no LLM output treated as an authorization decision
- no frontend-only authorization
- no cloud-hosted GitHub CLI, repository clone, or GitHub credential custody
- no cloud or collaborator supplied local path/command
