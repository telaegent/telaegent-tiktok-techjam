# Authorization module

This directory is the canonical product-authorization seam for the cloud
Telaegent architecture. It is separate from the preserved Telagent
Phoenix/conflict workflow under `src/telagent/`.

Current scope:

1. `types.ts` defines authorization-safe domain projections.
2. `repository.ts` defines the persistence-neutral snapshot loader.

The next layer will implement:

```text
trusted authenticated user
        + stable GitHub repository ID
        + conversation ID
                    |
                    v
PrivateRuntimeAuthorizationRepository
                    |
                    v
authorization service cross-checks every scope and state
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

