# Local GitHub Repository Proof Contract

**Status:** cloud ingestion and persistence implemented; local collection and
connector transport authentication remain open connector gates.

## Purpose and ownership

Khoa owns the authorization decision produced from a local repository proof.
Phuong owns the connector process, its outbound transport/authentication, and
the safe local execution of `gh`/`git` used to collect the facts.

```text
Telaegent website GitHub identity
        +
authenticated outbound connector principal (user + connector instance)
        +
safe local gh/git repository observation
        ↓
atomic repository proof RPC
        ↓
GitHub connection + repository access + project membership + opaque binding
```

Supabase is persistence. It does not authenticate the connector, run `gh`, or
receive a GitHub credential. The connector transport must authenticate first
and inject this trusted principal:

```ts
{
  authenticatedUserId: string; // Telaegent account UUID
  connectorInstanceId: string; // opaque installation identity
}
```

Neither field is accepted from the repository-proof body.

## Safe request

`POST /api/connectors/repository-proofs`

```ts
{
  version: 1;
  proofId: string;              // UUID idempotency key
  observedAt: string;           // ISO timestamp, bounded freshness
  github: {
    userId: string;             // canonical positive BIGINT decimal
    login: string;
  };
  repository: {
    id: string;                 // stable GitHub repository ID, decimal string
    owner: string;
    name: string;
    visibility: "public" | "private" | "internal";
    defaultBranch: string;
    currentBranch: string | null; // null means detached HEAD
    commitSha: string;          // lowercase 40-character SHA-1
    permission: "read" | "triage" | "write" | "maintain" | "admin";
  };
}
```

The schema is strict. It rejects extra properties, including `userId`, local
paths, remote URLs, tokens, credential-bearing output, commands, environment
variables, and repository content. `owner/name` is assembled on the server so
the caller cannot supply a contradictory full name. JavaScript never converts
GitHub numeric IDs to `number`.

The local connector should construct the request from parsed, allowlisted
fields. It must not upload raw `gh auth status`, `gh api`, `git remote`, or
process output.

## Atomic authorization result

`register_local_github_repository_proof` performs one transaction and returns:

```ts
{
  proofId: string;
  githubConnectionId: string;
  projectId: string;
  githubRepositoryId: string;
  connectorBindingId: string;
  accessStatus: "verified";
  membershipStatus: "active";
  bindingStatus: "ready";
  verifiedAt: string;
  replayed: boolean;
}
```

Before any mutation, the transaction locks and validates all existing state.
It requires:

- an active Telaegent account;
- the local stable GitHub user ID to equal the account's website-verified
  GitHub identity;
- a fresh observation (at most 15 minutes old and at most 5 minutes ahead);
- no archived project or explicitly revoked GitHub connection, repository
  access, membership, or connector binding;
- a monotonically current proof for that user and repository.

Unavailable, reconnect-required, and suspended records may recover after a new
successful proof. Explicitly revoked records remain revoked. A rejected proof
does not partially update another table.

`proofId` is a durable idempotency key. Reusing it with a different principal,
repository, connector, or payload digest is a conflict. Replaying an old proof
after the binding ceased to be ready is also a conflict; historical success
cannot claim current authorization.

## Loss and revalidation

The authenticated connector reports a bounded local loss event to:

`POST /api/connectors/repositories/:githubRepositoryId/unavailable`

```ts
{
  observedAt: string;
  reason:
    | "github_auth_required"
    | "repository_access_lost"
    | "repository_not_found"
    | "sso_reauthorization_required";
}
```

The database requires the exact user, repository, and current connector
instance. A valid loss event changes only that scope:

```text
repository access → revalidation_required
project membership → suspended
connector binding → unavailable
```

GitHub-auth and SSO reasons additionally change the user's GitHub connection to
`reconnect_required`. A stale event cannot undo a newer proof. A new valid proof
recovers non-revoked state and preserves the opaque binding ID.

After the durable transition succeeds, the HTTP boundary awaits a relay event
that unregisters only the same connector principal x repository binding and
cancels its active cloud job. Idempotent loss-event replays emit the event again
so a retry can repair process-local relay state after an interrupted callback.
Cancellation delivery is principal-bound and expires; it does not restore or
extend the unavailable binding.

## Deployment seam

The route module is intentionally optional. The cloud bootstrap must not mount
it until Phuong's connector transport supplies a real
`ConnectorPrincipalResolver`. The legacy shared API token and browser session
cookie are not connector authentication and must not be used as a substitute.

The RPCs and proof audit table are available only to Supabase `service_role`;
`anon` and `authenticated` have no table or function access. RLS is enabled
with no browser policies.

## Still open

- connector registration credential format, rotation, reconnect, and revocation;
- local `gh`/`git` parsing implementation and controlled live experiments;
- connector packaging/update security;
- safe repository metadata refresh and branch/worktree policy;
- retention/pruning policy for accepted proof idempotency records.
