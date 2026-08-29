# Telaegent GitHub Connection Design

**Status:** Canonical hackathon decision  
**Last updated:** 2026-08-29  
**Scope:** GitHub identity, authentication, repository checkout, collaborator verification, persistence, and revocation

> This document records an implementation decision. Future agents working on Telaegent should read this file before changing GitHub authentication or repository-access behavior.

## 1. Decision summary

Telaegent will **not require a Telaegent GitHub App for the hackathon**.

Each Telaegent user receives an isolated cloud runtime containing:

```text
User × Repository cloud runtime
├── GitHub CLI (`gh`)
├── Git
├── private repository checkout
├── Claude Code CLI
├── Codex CLI
├── private provider authentication/session state
└── private GitHub authentication state
```

The user authenticates GitHub CLI once through GitHub's browser/device flow. Telaegent persists the resulting authentication state in storage isolated to that user. GitHub CLI then lists and clones repositories using that user's own GitHub permissions.

Claude Code and Codex do not need to connect directly to GitHub. They run with the cloned repository as their working directory and inspect the local checkout.

### 1.1 Validation evidence — 2026-08-29

The initial Linux proof is recorded in
[`docs/research/github-cli-cloud-auth.md`](docs/research/github-cli-cloud-auth.md).

Observed with GitHub CLI 2.98.0 in an isolated Ubuntu WSL2 environment:

- `gh auth login --web --git-protocol https` produced a relayable device URL
  and one-time code even though the runtime had no browser opener;
- authentication survived new processes and a full WSL stop/start;
- `gh auth setup-git` configured HTTPS Git credentials through
  `gh auth git-credential`;
- the authenticated-user API found owned, direct-collaborator, and
  organization-member repositories;
- `gh repo list` returned only the five owned repositories while the API found
  nineteen accessible repositories;
- the private project resolved to stable numeric GitHub repository ID
  `1345851083`, including through its previous `owner/name` alias;
- the headless environment had no usable credential store, so GitHub CLI saved
  the OAuth credential in plaintext `hosts.yml` with mode `0600`.

Therefore the device-flow and repository-access hypotheses are validated for a
controlled hackathon environment, while ordinary filesystem persistence of
`hosts.yml` is explicitly rejected as a production credential design. Azure
Key Vault or equivalent protected injection/rehydration remains required.

An authorized Azure reproduction is prepared but has not yet been executed.
The disposable VM template, operator scripts, cleanup guardrails, and handoff
instructions are under
[`deploy/azure/github-auth-proof/`](deploy/azure/github-auth-proof/README.md).
Passing local template and script validation is not evidence that the Azure
runtime gate has passed.

## 2. Important architecture boundary

The revised Telaegent product is cloud-hosted:

```text
User browser
    ↓
Telaegent web application
    ↓
Telaegent backend
    ↓
isolated cloud runtime for one user × one repository
    ├── `gh` / Git
    └── Claude Code CLI and/or Codex CLI
```

There is no required LAN connection, laptop bridge, local Fastify server, peer-to-peer worker, or `npx @telagent/bridge connect` flow in this architecture.

The browser is the interface. The GitHub, Claude, and Codex CLIs run in Telaegent-managed cloud environments.

## 3. GitHub has two responsibilities

GitHub is used for:

1. Identifying the developer by their GitHub account.
2. Proving that the developer's own GitHub credentials can access a selected repository.

GitHub repository access does **not** automatically grant Telaegent collaboration permission.

Telaegent separately controls:

- project membership;
- collaborator connection requests;
- agent-to-agent communication permission;
- project-scoped revocation;
- per-message `Send / Edit / No` approval.

The authorization layers are:

```text
GitHub identity
        ↓
User's GitHub repository access
        ↓
Telaegent project membership
        ↓
Telaegent collaborator connection
        ↓
Human approval for each outbound message
```

## 4. First-time GitHub connection flow

From the Telaegent web application, the user clicks:

```text
[ Connect GitHub ]
```

The backend starts GitHub CLI authentication inside that user's isolated cloud environment:

```bash
gh auth login --web --git-protocol https
```

Telaegent surfaces the verification URL and one-time code in the browser:

```text
Connect GitHub

Open: https://github.com/login/device
Code: ABCD-EFGH

[ Open GitHub ]
```

The user opens GitHub, enters the code if requested, reviews the authorization, and approves it.

After successful authentication, the runtime executes:

```bash
gh auth status
gh auth setup-git
```

`gh auth setup-git` configures Git to use GitHub CLI as its credential helper.

Telaegent performs a live proof before marking the connection successful. Version checks alone are insufficient.

Conceptual connection states:

```text
not_connected
    ↓
connecting
    ↓
connected

Failure/revocation states:
reconnect_required
unavailable
revoked
```

## 5. Remembering the GitHub connection

The GitHub authentication state belongs to exactly one Telaegent user and must never be shared between users.

For the hackathon, persist the minimum GitHub CLI configuration/authentication state in a protected per-user location. The implementation must not place credentials in:

- Supabase ordinary application rows;
- repository files;
- Git configuration committed to the repository;
- logs;
- frontend local storage;
- another user's runtime volume.

Preferred production direction:

- store long-lived credential material in Azure Key Vault or an equivalent secret store;
- inject credentials into the correct runtime only when needed;
- keep filesystem permissions restrictive;
- redact command output and environment variables from logs.

Hackathon fallback, if secret-store integration is not ready:

- use a dedicated persistent volume or secret mount for each user;
- persist only the required GitHub CLI state;
- document that the isolation is a hackathon implementation and not a completed production security boundary.

On later runtime starts, execute:

```bash
gh auth status
```

If authentication is valid, reuse it without asking the user to log in again. If it is invalid, mark the connection `reconnect_required` and repeat the browser/device flow.

Do not silently substitute another user's token or a service-wide GitHub credential.

## 6. Repository selection and checkout

After GitHub is connected, Telaegent uses that user's GitHub CLI identity to list repositories they can access.

The backend should normalize repository results into a product-owned shape rather than exposing raw GitHub responses directly:

```ts
type RepositorySummary = {
  githubRepositoryId: number;
  owner: string;
  name: string;
  fullName: string;
  visibility: "public" | "private" | "internal";
  defaultBranch: string;
};
```

When the user selects a repository, Telaegent clones it into a runtime scoped to that user and repository:

```bash
gh repo clone OWNER/REPOSITORY
```

Runtime identity:

```text
runtime_id = Telaegent user ID × GitHub repository ID
```

Do not use only a repository name or URL as the durable identifier. GitHub's numeric repository ID is the canonical external repository identity.

Every user receives a separate checkout, even when two users select the same GitHub repository:

```text
User A × Repo X                User B × Repo X
separate filesystem           separate filesystem
separate GitHub auth          separate GitHub auth
separate Claude/Codex auth    separate Claude/Codex auth
separate provider sessions    separate provider sessions
separate private drafts       separate private drafts
```

## 7. Collaborator verification

For the hackathon, use a repository-scoped invitation rather than importing and displaying the entire GitHub collaborator list.

Recommended flow:

```text
User A selects Repo X
        ↓
User A creates a Repo X invitation or searches a known GitHub handle
        ↓
User B signs into Telaegent and connects their own GitHub CLI identity
        ↓
Telaegent verifies User B can access Repo X
        ↓
User B accepts the Telaegent project connection
        ↓
User A ↔ User B become connected only for Repo X
```

Verification should be performed using User B's own GitHub credentials, for example by requesting the repository through GitHub CLI:

```bash
gh api repos/OWNER/REPOSITORY
```

Verification succeeds only when:

1. the request succeeds for User B's authenticated GitHub identity;
2. the returned numeric GitHub repository ID matches the Telaegent project's stored repository ID;
3. the Telaegent project is active;
4. User B explicitly accepts the project connection.

Do not infer repository access solely from:

- a matching username;
- knowing the repository URL;
- possessing an invitation link;
- being a Telaegent user;
- frontend state.

An invitation link authorizes the user to request or accept a Telaegent connection. It does not replace GitHub repository-access verification.

## 8. Telaegent project permissions

Repository access and agent communication are different permissions.

GitHub answers:

> Can this user's GitHub identity access this repository?

Telaegent answers:

> May these two users' agents communicate about this repository?

Recommended connection state machine:

```text
not_connected
    ↓ request
pending
    ↓ recipient accepts
connected
    ↓ either side revokes
revoked
```

A connection is scoped by:

```text
project/repository ID
requester user ID
recipient user ID
```

A connection on Repo A never grants access or messaging permission on Repo B.

After a project connection is accepted, ordinary inbound project messages do not require repeated collaborator approval. However, every agent-prepared outbound message still requires the sending human to choose `Send`, `Edit`, or `No`.

## 9. Minimal logical data model

```text
users
- id
- github_user_id
- github_login
- github_avatar_url

github_connections
- user_id
- status
- connected_at
- last_verified_at
- credential_reference

repositories
- id
- github_repository_id
- owner
- name
- visibility
- default_branch

project_memberships
- project_id
- user_id
- github_access_verified
- github_access_verified_at
- status

project_connections
- id
- project_id
- requester_user_id
- recipient_user_id
- status
- requested_at
- accepted_at
- revoked_at

runtime_bindings
- id
- user_id
- project_id
- runtime_status
- workspace_reference
- github_connection_reference
- provider_binding_reference
```

`credential_reference` points to protected credential storage. It must not contain a raw GitHub token in an ordinary application table.

## 10. Revalidation and revocation

Revalidate GitHub repository access at least:

- when a user first joins a project;
- before provisioning or recreating their repository runtime;
- after GitHub authentication is refreshed;
- when starting a project conversation after a meaningful period of inactivity;
- when a GitHub API request indicates revocation or insufficient permission.

Hackathon implementations may use on-demand checks instead of webhooks.

If GitHub authentication expires or is revoked:

```text
GitHub request fails
        ↓
mark GitHub connection reconnect_required
        ↓
block new repository operations and agent runs requiring the repository
        ↓
show Reconnect GitHub
```

If the user loses access to one repository:

```text
mark that project membership suspended
revoke new runtime access for that project
preserve safe audit records
do not apply the revocation to unrelated projects
```

If either Telaegent collaborator revokes their connection, stop new cross-agent messaging for that project even if both users still have GitHub repository access.

## 11. Security requirements

Mandatory invariants:

- Never share GitHub credentials between users.
- Never mount User A's GitHub authentication state into User B's runtime.
- Never expose a GitHub token to Claude/Codex prompts or shared conversations.
- Never print tokens in logs, errors, traces, or audit events.
- Never store credentials in the repository checkout.
- Never treat frontend visibility as backend authorization.
- Never allow a remote collaborator to specify an arbitrary filesystem path.
- Never allow Repo A authorization to be reused for Repo B.
- Never give a collaborator direct access to another user's runtime or checkout.
- Only content explicitly approved through `Send / Edit / No` may cross into the shared conversation.

The runtime may use the user's repository privately to prepare an answer. The remote collaborator receives only the approved answer, not repository access.

## 12. Known downside of this decision

GitHub CLI authentication can grant broader user-level OAuth access than a repository-selective, read-only GitHub App. GitHub CLI authentication state is also sensitive credential material that Telaegent must protect in each cloud environment.

This is accepted for the hackathon because it:

- matches the product's per-user cloud CLI model;
- avoids requiring a Telaegent GitHub App installation;
- lets each user use their own GitHub identity and permissions;
- is feasible for a small controlled demo using team-owned accounts and repositories.

For a production beta, re-evaluate repository-selective GitHub App access and provider/vendor policies before onboarding external users.

## 13. Explicitly rejected hackathon designs

Do not implement these unless the canonical plan is deliberately revised:

### Required local bridge

Rejected because the revised product is cloud-hosted and the browser is the user interface.

### Required Telaegent GitHub App

Rejected for the hackathon because each user authenticates GitHub inside their own isolated cloud CLI environment. It remains a possible production alternative.

### Shared service-wide GitHub token

Rejected because it destroys per-user identity, repository permission verification, revocation boundaries, and runtime isolation.

### Personal access token pasted into Telaegent

Rejected because onboarding and credential handling are worse than GitHub's browser/device authorization flow.

### GitHub identity only, with no repository authentication

Rejected because Telaegent's cloud runtime must clone private repositories and verify that each project member can access the selected repository.

## 14. Implementation checklist

- [ ] Provision an isolated user runtime or authentication environment.
- [ ] Install `git` and GitHub CLI.
- [ ] Start `gh auth login --web --git-protocol https` from the backend/runtime manager.
- [ ] Relay only the verification URL, device code, and safe status to the frontend.
- [ ] Confirm the authenticated GitHub identity.
- [ ] Run `gh auth setup-git`.
- [ ] Persist authentication state in protected per-user storage.
- [ ] Implement `gh auth status` health checks.
- [ ] List and normalize accessible repositories.
- [ ] Store GitHub numeric repository IDs.
- [ ] Clone into separate user × repository workspaces.
- [ ] Verify invitees using their own GitHub credentials.
- [ ] Implement project-scoped pending/connected/revoked states.
- [ ] Revalidate GitHub access before runtime provisioning.
- [ ] Redact tokens and secrets from all logs.
- [ ] Implement GitHub disconnect and per-project revocation.
- [ ] Test two users with access to the same repository.
- [ ] Test one unauthorized user.
- [ ] Test expired/revoked authentication.
- [ ] Test that Repo A permission cannot access Repo B.

## 15. Demo script

```text
1. Phuong clicks Connect GitHub.
2. Telaegent shows GitHub's browser/device authorization flow.
3. Phuong authorizes once.
4. Telaegent displays repositories available to Phuong.
5. Phuong selects the demo repository.
6. Justin connects GitHub in his own isolated environment.
7. Justin opens Phuong's repository-scoped invitation.
8. Telaegent verifies Justin can access the same GitHub repository ID.
9. Justin accepts the Telaegent project connection.
10. Telaegent creates separate repository checkouts for both users.
11. Phuong's Codex CLI and Justin's Claude Code CLI operate on their respective checkouts.
12. Messages cross between them only after the relevant human presses Send.
```

## 16. Canonical statement for future agents

> For the Telaegent hackathon build, GitHub access is authenticated separately inside each user's isolated cloud environment through GitHub CLI's browser/device flow. GitHub CLI uses the user's own permissions to list and clone repositories. Telaegent verifies that both users can access the same numeric GitHub repository ID, then manages a separate project-scoped collaborator connection. Claude Code and Codex run as real CLI processes against separate cloud checkouts. A Telaegent GitHub App is not required for the hackathon.
