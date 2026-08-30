# Supabase private-runtime authorization snapshot contract

**Owners:** Khoa (authorization mapping/policy), Thai (Supabase schema/RPC)

**Status:** schema/RPC deployed; backend client implemented; live credential smoke passed 2026-08-30

This is the persistence boundary for one private Claude Code or Codex turn. It
does not grant permission by itself. It loads authorization facts, and
`PrivateRuntimeAuthorizationService` makes the allow/deny decision.

## Call shape

The trusted Fastify backend calls one narrow client method:

```ts
fetchPrivateRuntimeAuthorizationSnapshot(
  {
    authenticatedUserId,
    githubRepositoryId,
    conversationId,
    maximumProjectConnections,
  },
  { signal },
): Promise<unknown>
```

`authenticatedUserId` must come from verified server authentication context.
It must never come from a user-editable request-body field.

The concrete backend client calls Thai's deployed
`load_private_runtime_authorization_snapshot` RPC. The strict TypeScript
repository remains independent of physical table names.

The deployment chooses persistence explicitly with
`AUTHORIZATION_PERSISTENCE=memory|supabase`. `memory` is the fail-closed local
default. A Supabase outage must never fall back to memory because cached local
facts could resurrect a revoked permission.

## Database execution requirements

- Return one JSON object from one PostgreSQL statement or one read-only
  transaction so facts cannot mix two revocation states.
- Store the GitHub repository identifier as a positive signed `BIGINT` when
  practical, but project it as decimal text in RPC JSON.
- Enforce `1 <= maximumProjectConnections <= 100` and apply the bound in SQL.
- Load inactive, pending, closed, unavailable, and revoked rows rather than
  filtering them out. Product authorization decides what those states mean.
- Select only the canonical fields below.
- Never select OAuth tokens, GitHub CLI credentials, provider credentials,
  credential references, provider session IDs, prompts, private drafts, or raw
  runtime output.
- Forward the abort signal from Fastify through the Supabase client when the
  SDK/transport supports it.

## Canonical response DTO

Every top-level key is required. A singular record that does not exist is
represented by `null`; relationships use an empty array. Unknown keys are
rejected.

```ts
{
  user: UserAccount | null;
  githubConnection: GitHubConnection | null;
  repositoryAccess: GitHubRepositoryAccess | null;
  project: RepositoryProject | null;
  membership: ProjectMembership | null;
  conversation: ProjectConversation | null;
  projectConnections: ProjectConnection[];
  runtimeBinding: RuntimeBinding | null;
}
```

The exact field definitions and state-dependent timestamp rules are enforced
by `apps/server/src/authorization/supabase-authorization-repository.ts`.
Notable constraints:

- identifiers are bounded and control-character free;
- timestamps are valid ISO-8601 instants with an offset;
- `githubRepositoryId` is a canonical positive decimal string no greater than
  `9223372036854775807`;
- conversation participants and project-connection pairs are unique;
- a `ready` runtime binding must contain `workspacePath`;
- a non-ready runtime binding must not contain `workspacePath`;
- additional fields at any level are rejected.

The runtime workspace path is necessary inside this trusted backend snapshot,
but the RPC and adapter must never be browser-callable and the DTO must never
be serialized to the frontend.

## Supabase exposure rules

Prefer a backend-only database role or narrowly granted RPC. Do not grant
browser `anon` or ordinary `authenticated` roles direct read access to runtime
bindings or workspace metadata.

If the RPC uses `SECURITY DEFINER`:

- revoke default/public execute privileges;
- grant execution only to the backend role;
- set a safe empty `search_path` and fully qualify referenced objects;
- do not use caller-supplied user IDs as proof of identity in a browser call;
- keep RLS enabled as defense in depth where applicable.

The Supabase service-role credential belongs only in backend secret storage. It
must never appear in Vite variables, browser bundles, logs, repository files,
or ordinary application rows.

The deployed backend uses a modern `sb_secret_...` API key in the `apikey`
header. It does not put that opaque API key in an `Authorization: Bearer`
header; that header is for a Supabase Auth user JWT. Transport rejects redirects,
requires HTTPS, omits ambient browser credentials, forwards cancellation, and
bounds successful response bodies to 1 MiB before strict DTO validation.

## Failure behavior

- Missing records are valid facts and lead to authorization denial.
- Malformed or unexpected RPC JSON produces a generic invalid-snapshot error.
- Database/network failures produce a generic persistence-unavailable error.
- Timeout or cancellation aborts the read and becomes a generic authorization
  unavailable response.
- Error messages never contain record values, repository IDs, workspace paths,
  credentials, or validation issue details.

No successful authorization result is cached across turns. The backend reads
again immediately before execution so GitHub access, membership, project
connections, and runtime bindings remain revocable.

## Live contract evidence — 2026-08-30

Run from the repository root:

```text
npm run smoke:authorization:supabase
```

The smoke uses the production backend client, repository adapter, and strict
DTO mapper against the deployed Supabase RPC. It supplies random nonexistent
user and conversation UUIDs plus a non-production repository-ID sentinel, so
the call is read-only and must return the canonical eight-key empty snapshot.
It then repeats the RPC request with the browser publishable key and requires a
non-success response. The script discards response bodies and never prints
URLs, credentials, identifiers, snapshots, or stack traces.

Observed result:

- the backend secret role could execute the deployed RPC;
- the payload passed strict DTO validation;
- the synthetic unknown scope remained fail-closed;
- the browser publishable role could not execute the RPC.

This smoke verifies the live transport, RPC name, backend grant, browser-role
denial, and empty-snapshot contract. It does not claim that Supabase Auth JWT
middleware, seeded successful authorization, workspace existence, provider
execution, or revocation during a live turn has been proven. Those remain
separate integration gates.
