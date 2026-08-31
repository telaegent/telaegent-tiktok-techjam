# Authorization module

This directory is the canonical product-authorization seam between the cloud
control plane and outbound local connectors. It is separate from the preserved Telagent
Phoenix/conflict workflow under `src/telagent/`.

Current scope:

1. `types.ts` defines authorization-safe domain projections.
2. `repository.ts` defines the persistence-neutral snapshot loader.
3. `private-runtime-authorization.ts` enforces the product permission checks.
4. `workspace-boundary.ts` rejects traversal and symlink escapes.
5. `in-memory-authorization-repository.ts` provides an indexed, atomic
   development/test adapter with the same fact-loading boundary expected from
   Supabase.
6. `authorized-private-runtime-turn.ts` converts a fresh authorization result
   into Phuong's provider-session and owner-scoped progress flow.
7. `github-repository-id.ts` is the single decimal-string validator for the
   stable external repository boundary.
8. `supabase-authorization-repository.ts` defines the strict RPC DTO, validates
   untrusted persistence JSON, and adapts a narrow Supabase client port.
9. `supabase-authorization-client.ts` is the backend-only, bounded HTTP client
   for Thai's deployed RPC.
10. `authorization-repository-factory.ts` explicitly selects fail-closed local
    memory or Supabase persistence without outage fallback.
11. `capability-types.ts`, `capability-repository.ts`, and
    `capability-route-authorization.ts` define task identity and exact-grant
    routing authorization for the capability-scoped follow-up design.

The implemented internal flow is:

```text
trusted authenticated user
        + stable GitHub repository ID
        + conversation ID
                    |
                    v
PrivateRuntimeAuthorizationRepository (one consistent, bounded read)
                    |
                    v
authorization service cross-checks every scope, state, and revocation
                    |
                    v
authorized opaque connector binding
                    |
                    v
authorized private-turn starter
  - binding ID from authorization only; no local path in cloud state/job
  - read-only sandbox, no network, bounded turns
                    |
                    v
provider session manager / owner-scoped private progress stream
```

## Ownership boundary

- Khoa owns the domain rules, authorization service, denial behavior, and
  security tests.
- Khoa owns the authorization DTO validation, database-to-domain mapping, and
  repository adapter behavior.
- Thai owns Supabase infrastructure, migrations, SQL tests, and the
  transactional RPC/schema.
- Khoa owns the backend RPC client configuration, transport safety, strict DTO
  mapping, and authorization policy above that RPC.
- Phuong consumes only a successful opaque binding result and dispatches a
  bounded job to the owning local connector.
- Duy consumes later HTTP/realtime APIs and never receives a workspace path.

## Invariants retained by this contract

- Supabase/Telaegent identity is distinct from GitHub CLI authorization.
- GitHub's stable numeric repository ID is represented as a decimal string and
  is the external repository scope key. It is bounded to PostgreSQL's positive
  signed `BIGINT` range and is never parsed into a JavaScript number.
- GitHub access, project membership, collaborator connection, and message
  approval remain separate permissions.
- A runtime binding belongs to exactly one user and one project/repository and
  represents an opaque local connector registration.
- No binding or authorization DTO exposes a local workspace path.
- Credentials and credential references are not part of authorization-domain
  projections.
- Repository adapters load facts; they do not decide authorization.
- Browser/untyped input cannot select a binding ID, local workspace, sandbox,
  network mode, provider session ID, or turn budget.

## Security behavior

`authorizePrivateRuntime()` fails closed unless all of these agree:

- active authenticated user;
- connected GitHub identity owned by that user;
- fresh, independently verified access to the requested numeric GitHub repo;
- active repository project and active user membership;
- active conversation in the same project with unique, bounded participants;
- one connected project relationship from the user to every other participant;
- ready connector binding owned by the same user and project/repository.

The repository is read again for every private turn. Do not cache an allow
decision across turns because GitHub access, membership, connections, and
runtime bindings are revocable. Authorization is also repeated after the
job queue and immediately before connector dispatch. This closes the
window where a turn was allowed, waited behind another turn, and could
otherwise run after revocation. If its binding rotated while
queued, the stale request fails closed and must be retried. Denials have one
public message; internal reason codes are non-enumerable and must remain
server-side.

Realpath containment is a connector-side responsibility after it resolves the
opaque binding to its private local workspace mapping. The cloud must never
receive or validate that path.

The private-turn starter accepts only a backend-prepared prompt and durable
summary plus the requested provider and authorization scope. It reconstructs
the runtime request field-by-field instead of spreading caller data, so extra
fields supplied by untyped JavaScript cannot override middleware policy. This
path permits only `sender_draft` and `recipient_answer`, uses a read-only
sandbox with no tool network, validates UTF-8 byte limits, and never exposes a
provider session ID. A future write-capable workflow needs a separate reviewed
authorization/policy seam; do not relax this one.

## In-memory adapter lifecycle

`InMemoryPrivateRuntimeAuthorizationRepository` is suitable for local
integration, tests, and development before Thai's Supabase adapter is wired.
It is not durable production persistence. It clones input/output values,
indexes all unique lookup keys, bounds participant/connection reads, and
builds replacement indexes before one atomic swap. `replaceData()` therefore
models immediate revocation without mixing old and new facts in one read.

Do not mutate this adapter record-by-record in request handlers. Construct one
complete snapshot from trusted server state and replace it atomically. The
production Supabase adapter must preserve the same logical-snapshot behavior.

## Supabase/Postgres adapter requirements

`SupabasePrivateRuntimeAuthorizationRepository` and its strict mapper are
implemented without depending on physical table names or the Supabase SDK.
`SupabaseAuthorizationRpcClient` calls the single deployed RPC, honors the
supplied abort signal and connection limit, bounds the response, and returns
the untrusted canonical DTO for strict mapping. See
[`supabase-authorization-snapshot-contract.md`](../../../../docs/architecture/supabase-authorization-snapshot-contract.md).

Persistence is selected only through `AUTHORIZATION_PERSISTENCE`. It defaults
to an empty memory repository that denies every request. Supabase requires an
HTTPS `SUPABASE_URL` and backend-only `SUPABASE_SECRET_KEY`. The factory never
falls back to memory after a Supabase error because doing so could reuse facts
from before a revocation.

The RPC must project `github_repository_id` as decimal text even when the
database stores it as `BIGINT`. It must select only the fields in the DTO and
must never return credential material, credential references, provider session
IDs, or unrelated rows. Recommended indexes/constraints:

- unique repository project by `github_repository_id`;
- unique repository access by `(user_id, github_repository_id)`;
- unique membership by `(project_id, user_id)`;
- unique runtime binding by `(project_id, user_id)`;
- indexed conversation lookup by `(conversation_id, project_id)`;
- indexed project-connection lookup by project and both participant IDs.

RLS remains defense in depth. The browser must not query runtime bindings or
connector metadata directly; this service runs in the trusted backend.

## Capability-routing foundation

The cloud now has contracts for one bounded two-peer task and one exact
read-only resource grant. `CapabilityRouteAuthorizationService` checks the
task, repository, conversation, both memberships, project connection, exact
peer/resource/operation, expiry/revocation state, and the owner's ready opaque
connector binding before producing a route envelope.

That envelope always carries `requiresLocalAuthorization: true`. It is not file
read permission. The owner's connector must still resolve the opaque resource,
re-check its local grant and realpath boundary, apply hard secret denials and
byte limits, and let its file broker perform the read. No local path or content
can be represented by the cloud authorization types.

`SupabaseCapabilityRouteAuthorizationRepository` is what makes that service
reachable: migration `20260831093000` adds
`load_capability_route_authorization_snapshot`, and the repository validates its
untrusted JSON before the service sees it. A snapshot carrying a canonical path,
write authority, or a conversation wider than two peers is rejected as malformed
rather than merely unauthorized.

Two more functions in the same migration write and spend authority.
`record_capability_grant` takes an identifier the owner's connector already
minted - the cloud can route an identifier but must never invent one - clamps
expiry to the task, and reuses an existing active grant instead of fragmenting
one approved file into two rows. `consume_capability_grant` locks the row,
takes the time from the database rather than the caller, and returns a single
`unavailable` outcome for every failure so a peer cannot probe which grants
exist. `supabase/tests/capability_route_functions_test.sql` proves this.

The scope-expansion API and UI, the server path that calls
`consume_capability_grant`, the bounded multi-round loop, and resource transfer
are still unimplemented. Do not describe these contracts as a working autonomous
capability loop.
