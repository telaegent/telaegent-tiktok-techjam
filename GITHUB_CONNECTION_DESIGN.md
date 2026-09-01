# Telaegent GitHub Connection Design

**Status:** Canonical hackathon decision  
**Last updated:** 2026-08-30
**Scope:** Local GitHub identity, repository proof, connector binding,
collaborator verification, revalidation, and revocation

## 1. Decision summary

Telaegent does not require a GitHub App for P0 and does not authenticate or run
GitHub CLI in its cloud.

Each developer uses the GitHub and repository state already on their machine:

```text
Developer machine
├── selected local repository/worktree
├── Git and GitHub CLI (`gh`)
├── existing local GitHub authentication
├── Claude Code and/or Codex
└── Telaegent connector
```

The connector proves access to the selected repository, binds it to the
developer's Telaegent account and stable GitHub repository ID, and sends only
safe metadata to the cloud. It never uploads the checkout, GitHub credentials,
credential files, or local path.

The cloud is a control plane and relay:

```text
browser -> Telaegent cloud <- outbound connector -> local gh/repo/provider
```

## 2. Local GitHub connection

The connector checks:

```bash
gh auth status
git remote get-url origin
git rev-parse HEAD
git branch --show-current
```

It uses `gh api` when needed to resolve and verify the stable numeric GitHub
repository ID. A version check alone is not proof of authentication or access.

If `gh auth status` fails, the product asks the developer to authenticate
locally. The developer may run `gh auth login` themselves. Telaegent cloud does
not start, relay, scrape, persist, refresh, or revoke the GitHub CLI login.

## 3. Repository registration

A repository becomes a Telaegent project only when:

1. the developer is authenticated to Telaegent;
2. the local connector is authenticated as that developer/machine;
3. the developer deliberately selects one local repository/worktree;
4. local Git/GitHub CLI proves access to its stable GitHub repository ID;
5. the connector registers safe repository metadata;
6. the cloud creates an opaque connector binding for that user × repository.

Safe registration metadata may include:

```ts
type RepositoryRegistration = {
  githubRepositoryId: string; // positive PostgreSQL BIGINT decimal
  owner: string;
  name: string;
  fullName: string;
  visibility: "public" | "private" | "internal";
  defaultBranch: string;
  currentBranch: string;
  commit: string;
};
```

It must not include:

- the absolute or relative local workspace path;
- repository contents or unapproved diffs;
- GitHub tokens, credential references, or `hosts.yml`;
- environment variables or provider credentials;
- arbitrary executable or command configuration.

Normalize the GitHub repository ID once to a canonical decimal string. Domain
objects, HTTP JSON, Supabase DTOs, connector bindings, and conversation scopes
must never convert it to a JavaScript number.

## 4. Connector binding

The cloud stores an opaque binding, not a cloud runtime or workspace:

```text
connector_binding_id
user_id
project_id
github_repository_id
status: connecting | online | busy | offline | unavailable | revoked
safe branch/commit metadata
last_seen_at
```

The local connector stores the private mapping:

```text
connector_binding_id -> registered local workspace + selected provider
```

Cloud jobs identify only the binding and bounded job type. They never contain a
path, shell command, executable, credential, or provider-home location. The
connector resolves its local workspace and provider after verifying the job's
user, project, repository, purpose, expiry, and integrity.

## 5. Repository discovery

P0 may begin from `telaegent connect .`, which avoids uploading or enumerating
the developer's entire repository list. If a local repository picker is added,
the connector may use the authenticated-user repository API through local
`gh api`; `gh repo list` alone is not a universal list of accessible repos.

Only deliberately selected repositories become cloud projects.

## 6. Collaborator verification

Use mutual proof of access rather than requiring one user to enumerate every
GitHub collaborator:

```text
User A's connector proves repo ID 123
User B's connector independently proves repo ID 123
        -> both are eligible for a project-scoped request
        -> User B explicitly accepts
```

Verification for User B must use User B's own local GitHub identity and must
confirm the returned numeric repository ID. Do not infer access from a username,
repository URL, invitation possession, frontend state, or another user's proof.

## 7. Permission layers

These permissions remain distinct:

```text
Telaegent identity
        -> local connector authentication
        -> local GitHub repository proof
        -> Telaegent project membership
        -> project-scoped collaborator connection
        -> human approval for exact outbound content
```

A project connection permits messaging. It does not grant direct filesystem
access, arbitrary local execution, private-draft access, another project, or
automatic sending.

## 8. Revalidation and revocation

Revalidate local repository access at least:

- on first registration;
- when the connector reconnects after a meaningful offline period;
- before accepting a new project-scoped job when proof is stale;
- after local GitHub authentication changes;
- when GitHub reports revocation or insufficient permission.

If the connector is offline, the cloud must not claim the repository/provider
is available or attempt cloud execution. Jobs should remain bounded/expiring or
fail visibly according to the delivery contract.

If GitHub access is lost, suspend that project membership and binding without
affecting unrelated projects. If either collaborator revokes the project
connection, stop new cross-agent jobs even when both still have repository
access.

Disconnecting Telaegent removes/revokes the cloud connector binding and local
connector registration. It does not silently run `gh auth logout`, because the
GitHub CLI identity belongs to the developer and may be used outside Telaegent.

## 9. Security invariants

- Never upload, store, log, or relay GitHub credentials.
- Never upload the repository checkout by default.
- Never include a local path in cloud state or a job payload.
- Never let the cloud or collaborator select an executable or command.
- Never reuse User A's repository proof or binding for User B.
- Never reuse Repo A authorization for Repo B.
- Never give a collaborator direct access to another user's connector, repo,
  provider session, or private draft.
- Only content explicitly approved through `Send / Edit / No` may enter the
  shared conversation.
- Deterministic policy remains authoritative for obvious secret and
  cross-project denials.

## 10. Historical cloud-auth evidence

[`docs/research/github-cli-cloud-auth.md`](docs/research/github-cli-cloud-auth.md)
records a 2026-08-29 experiment proving that `gh` device authentication can run
in a headless Linux environment. That evidence remains reproducible research,
but its cloud-custody design conclusion is superseded. The canonical product
uses the developer's existing local GitHub CLI identity.

A short-lived Azure VM package was written to reproduce that experiment in the
cloud. It was removed once the local connector became canonical, and cloud
GitHub CLI custody must not be revived as the product onboarding path.

## 11. Implementation checklist

- [ ] Implement `telaegent connect .` or equivalent.
- [ ] Authenticate connector-to-cloud without exposing local credentials.
- [ ] Verify `gh auth status` locally.
- [ ] Resolve normalized remote and stable numeric GitHub repository ID locally.
- [ ] Register safe repository/branch/commit metadata only.
- [ ] Store an opaque cloud connector binding with presence state.
- [ ] Store the binding-to-workspace mapping only on the developer machine.
- [ ] Detect and live-probe local Claude Code/Codex.
- [ ] Implement outbound WebSocket or long-poll delivery.
- [ ] Sign/validate, expire, acknowledge, cancel, and deduplicate bounded jobs.
- [ ] Revalidate project/repository access before execution when required.
- [ ] Test two users with the same repository ID.
- [ ] Test unauthorized user and Repo A -> Repo B denial.
- [ ] Test offline/reconnect/revoked connector behavior.
- [ ] Test that no path, token, credential file, or repository content appears in
      cloud registration, logs, or job payloads.

## 12. Demo script

```text
1. Phuong signs into Telaegent and runs `telaegent connect .` locally.
2. The connector verifies Phuong's local GitHub identity and repository ID.
3. It detects and probes Phuong's locally authenticated Codex.
4. Justin independently registers the same repository ID and local Claude Code.
5. Justin accepts the project-scoped Telaegent connection.
6. Phuong prepares and approves a request.
7. Telaegent cloud routes the bounded job to Justin's outbound connector.
8. Justin's local Claude inspects Justin's local repo and prepares a candidate.
9. Justin approves; only the approved response enters shared cloud memory.
10. Show that repositories, CLI credentials, and provider sessions never left
    either developer machine.
```

## Canonical statement

> Telaegent uses a cloud coordination plane around locally running agents. Each
> developer's connector uses that developer's local GitHub CLI identity,
> selected repository, Claude Code/Codex authentication, tools, and provider
> sessions. The cloud stores safe project metadata and an opaque connector
> binding, routes bounded jobs, and persists only human-approved collaboration.
