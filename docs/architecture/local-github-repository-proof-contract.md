# Local GitHub Repository Proof Contract

**Status:** cloud ingestion and persistence of authenticated local GitHub
repository proofs implemented for public, private, and internal repositories.

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

The request is an attestation from an authenticated local connector, not an
arbitrary browser assertion. The connector constructs it from allowlisted,
parsed `gh api` and `git` results on the developer's machine. Before calling
the atomic registration RPC, the control plane checks that the proof's GitHub
numeric user ID is the one linked to the authenticated Telaegent account. The
RPC repeats that identity check and validates freshness, stable repository
scope, revocation state, and replay state before creating membership.

This contract is identical for public, private, and internal repositories.
Telaegent does not send a second anonymous request to `api.github.com`: such a
request cannot prove private access, introduces a deployment-wide shared-IP
quota, and would contradict the canonical local-GitHub authorization flow.

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
The service reaches this transaction only after connector authentication,
strict proof parsing, freshness validation, and the identity preflight above.
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

## Browser setup status

After issuing a connector credential, the signed-in browser may poll:

`GET /api/connectors/installations/:connectorInstanceId/status`

The route derives the user from the opaque Telaegent session; it never accepts
a user ID from the browser. Its backend-only RPC scopes by that user and the
validated installation ID and returns at most 25 bindings. The response may
contain safe repository identity, proof/access/membership/binding status, and
last-seen timestamps. It cannot contain the connector bearer or hash, a local
path, remote URL, GitHub/provider credential, provider session, or raw command
output. Both credential issuance and setup status use `Cache-Control: no-store`.

The durable status supports truthful onboarding after repository proof. It is
not a durable delivery guarantee: the present long-poll relay remains
process-local, and a timestamp cannot prove that a connector will stay online.

## Project discovery

The signed-in browser lists its durable, locally proven projects through:

`GET /api/projects?limit=20&cursor=...`

The service derives the user from the Telaegent session and uses stable GitHub
repository ID keyset pagination rather than offsets. The backend-only RPC joins
that exact user's membership, GitHub repository access, GitHub connection, and
opaque runtime binding. It deliberately returns inactive/revoked states so the
UI can explain recovery or revocation instead of silently presenting an old
project as authorized. Another user's private project or binding cannot enter
the result. Pages contain at most 50 projects, are non-cacheable, and expose no
local path, credential, remote URL, repository contents, provider session, or
private draft.

## Still open

- connector packaging, secure local credential storage, signed updates, and reconnect/backoff;
- local `gh`/`git` parsing implementation and controlled live experiments;
- safe repository metadata refresh and branch/worktree policy;
- retention/pruning policy for accepted proof idempotency records.
- controlled live experiments covering private, internal, organization, and
  collaborator-not-owner repositories.
