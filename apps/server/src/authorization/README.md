# Authorization module

This directory is the canonical product-authorization seam for the cloud
Telaegent architecture. It is separate from the preserved Telagent
Phoenix/conflict workflow under `src/telagent/`.

Current scope:

1. `types.ts` defines authorization-safe domain projections.
2. `repository.ts` defines the persistence-neutral snapshot loader.
3. `private-runtime-authorization.ts` enforces the product permission checks.
4. `workspace-boundary.ts` rejects traversal and symlink escapes.

The next layer will implement:

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
AuthorizedPrivateRuntime
                    |
                    v
provider session manager / private progress stream
```

## Ownership boundary

- Khoa owns the domain rules, authorization service, denial behavior, and
  security tests.
- Thai owns Supabase infrastructure and the adapter that loads the repository
  snapshot.
- Phuong consumes only a successful `AuthorizedPrivateRuntime` result.
- Duy consumes later HTTP/realtime APIs and never receives a workspace path.

## Invariants retained by this contract

- Supabase/Telaegent identity is distinct from GitHub CLI authorization.
- GitHub's stable numeric repository ID is represented as a decimal string and
  is the external repository scope key.
- GitHub access, project membership, collaborator connection, and message
  approval remain separate permissions.
- A runtime binding belongs to exactly one user and one project/repository.
- Only a ready runtime binding exposes its server-controlled workspace path.
- Credentials and credential references are not part of authorization-domain
  projections.
- Repository adapters load facts; they do not decide authorization.

## Security behavior

`authorizePrivateRuntime()` fails closed unless all of these agree:

- active authenticated user;
- connected GitHub identity owned by that user;
- fresh, independently verified access to the requested numeric GitHub repo;
- active repository project and active user membership;
- active conversation in the same project with unique, bounded participants;
- one connected project relationship from the user to every other participant;
- ready runtime binding owned by the same user and project/repository;
- existing workspace whose real path is a child of the configured runtime root.

The repository is read again for every private turn. Do not cache an allow
decision across turns because GitHub access, membership, connections, and
runtime bindings are revocable. Denials have one public message; internal
reason codes are non-enumerable and must remain server-side.

Realpath containment closes ordinary traversal and symlink escapes. The
runtime launcher must still mount/open the authorized workspace in the same
isolation boundary to avoid a filesystem time-of-check/time-of-use race.

## Supabase/Postgres adapter requirements

Thai's adapter should load the snapshot with one SQL statement or transaction,
honor the supplied abort signal and connection limit, select only the fields in
the interface, and never return credential references. Recommended
indexes/constraints:

- unique repository project by `github_repository_id`;
- unique repository access by `(user_id, github_repository_id)`;
- unique membership by `(project_id, user_id)`;
- unique runtime binding by `(project_id, user_id)`;
- indexed conversation lookup by `(conversation_id, project_id)`;
- indexed project-connection lookup by project and both participant IDs.

RLS remains defense in depth. The browser must not query runtime bindings or
workspace metadata directly; this service runs in the trusted backend.
