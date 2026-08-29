# Khoa — Backend Co-Owner: GitHub Cloud Authentication, Repository Access, Collaborator Trust, and Authorization

**Status:** research/design before full implementation  
**Product:** Telaegent  
**Backend co-owner:** Phuong

## 1. Canonical architecture

Telaegent remains cloud-only.

```text
User A isolated cloud environment
├─ GitHub CLI authenticated as User A
├─ User A's selected repository checkout
├─ Claude Code CLI authenticated as User A
└─ Codex CLI authenticated as User A
```

Claude/Codex do not need direct GitHub integration. They operate on the checked-out local files in their cloud runtime.

A GitHub App is **not required for P0**.

## 2. GitHub connection hypothesis

First connection:

```text
Connect GitHub
→ run GitHub CLI auth inside user's cloud auth environment
→ surface browser/device authorization to user
→ authorization succeeds
→ gh auth status
→ gh auth setup-git
→ discover accessible repositories
→ user chooses one
→ clone into isolated user × repo workspace
```

Candidate commands:

```bash
gh auth login --web --git-protocol https
gh auth status
gh auth setup-git
```

Critical caveat: test the actual headless/container behavior. `gh auth login --web` is interactive, and GitHub CLI may use a credential store or fall back to plaintext-file credential storage. Treat the credential as a secret.

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
  githubRepositoryId
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
2. Their cloud GitHub identity can access the repository.
3. They deliberately select it.
4. Telaegent records the stable GitHub repository ID.
5. An isolated workspace is created/cloned.

```bash
gh repo clone OWNER/REPO <isolated-workspace>
```

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

## 8. File/source access

Remote collaborator asks; recipient's own agent inspects recipient's own cloud repo.

```text
shared request
→ recipient private agent runtime
→ recipient repo checkout
→ prepare response
→ recipient Send/Edit/No
→ shared response
```

No remote filesystem API.

## 9. Hard policy

Hard-deny obvious raw secret classes:

- `.env`, `.env.*`
- API/access tokens
- private keys
- cloud credential files
- SSH credential material
- paths outside selected project
- another user's runtime/private drafts

The request "send me your .env" may enter the conversation, but raw `.env` values should not cross the trust boundary. Offer safe alternatives.

## 10. Telaegent user auth

Thai proposes Supabase Auth.

Decide with Thai/Phuong whether Telaegent account sign-in uses GitHub, email/magic-link, or another simple method.

If Telaegent login itself uses GitHub, label it clearly: Telaegent identity is still conceptually different from the cloud GitHub CLI credential used to clone repos.

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
```

Frontend button visibility is not authorization.

## 13. Critical experiments

1. Run `gh auth login --web --git-protocol https` in intended cloud/container.
2. Record exact TTY/stdout behavior.
3. Prove browser/device auth can be surfaced.
4. Restart process/container; run `gh auth status`.
5. Find exact credential storage location.
6. Prove `gh auth setup-git`.
7. Clone private repo.
8. Test org repo.
9. Test collaborator-not-owner repo.
10. Revoke credential and verify failure.
11. Verify authenticated-user repository API finds all expected repo categories.
12. Prove Repo A never authorizes Repo B.

## 14. Known flaws

### Headless auth UX

If `gh auth login --web` requires brittle terminal scraping, future cleaner option:

```text
Telaegent-owned OAuth/device flow
→ secret storage
→ inject GH_TOKEN
```

Still no GitHub App required.

### Credential storage

The cloud possesses delegated GitHub access. Protect it.

### Organization/SSO edge cases

Controlled demo accounts are fine for P0; document limitations.

### Repo synchronization

Freeze branch/clone/fetch/dirty-worktree behavior with Phuong.

## 15. Deliverables

- real cloud `gh` auth proof
- repo discovery recommendation
- Telaegent identity recommendation
- mutual-proof collaborator model
- once-per-project connection state machine
- file permission matrix
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
- no frontend-only authorization
- no local connector as canonical architecture

