# Cloud-to-local connector seam

> **Status: first sender pipeline implemented; broader connector product still
> pending.** The cloud now has a bounded long-poll `ConnectorJobRelay`, dedicated
> revocable connector credentials, repository-proof binding activation, safe
> progress/result routes, cancellation, and a connector-side reference monitor.
> With Supabase authorization and conversation persistence enabled, the browser
> sender-draft API is composed through a durable context loader and this relay.
> Do not describe the complete two-user collaboration product as end to end yet:
> recipient-job orchestration, polished connector setup, and deployed live proof
> remain open.

Canonical cloud orchestration dispatches an authorized, bounded, path-free job
through `ConnectorTurnExecutor`. A job contains an opaque connector binding,
stable repository scope, provider, purpose, bounded prompt/context, schema name,
correlation ID, execution budget, and the authorized sandbox/network policy the
connector must enforce locally.

It never contains a local path, executable, command, environment variable,
credential, provider-home location, or provider session ID. The owning local
connector validates the job and resolves its private binding-to-workspace and
provider mapping before invoking a local runner.

The existing Claude/Codex runners and `ProviderSessionManager` are local adapter
building blocks and test/research utilities currently colocated in the server
package. The cloud bootstrap leaves `ENABLE_LEGACY_LOCAL_PLAYGROUND=0` and must
not construct those runners. A future package move may relocate them without
changing this trust boundary.

## Local repository proof seam

The Khoa-owned cloud ingestion/persistence contract is documented in
[`docs/architecture/local-github-repository-proof-contract.md`](../../../../docs/architecture/local-github-repository-proof-contract.md).
Its HTTP routes are mounted when GitHub identity/Supabase are configured. The
browser session may issue or revoke a connector credential, but repository
proofs, polling, and results accept only that dedicated bearer credential. The
legacy shared API token is not connector authentication.

## Current proof workflow

1. Sign in through the website.
2. `POST /api/connectors/credentials` with a stable, random installation ID.
   Save the returned credential locally; the backend stores only its hash. The
   response is explicitly non-cacheable and the browser must not persist it.
3. Set `TELAEGENT_URL`, `TELAEGENT_CONNECTOR_INSTANCE_ID`, and
   `TELAEGENT_CONNECTOR_CREDENTIAL` in the local shell.
4. Run `npm.cmd run connector:connect -- connect .` from the Telaegent source
   root in PowerShell. The script builds the connector before starting it, so
   it does not depend on the development-time TypeScript loader.

Use `--provider codex` or `--provider claude` to allow only one locally chosen
provider for this connector process. The default, `--provider auto`, allows all
locally authenticated providers; a cloud job still names its provider
explicitly and the connector never silently substitutes another one.

The connector canonicalizes the Git root, collects an allowlisted `gh`/`git`
repository proof, receives an opaque binding, detects locally authenticated
Claude Code and Codex CLIs, and runs one fixed read-only relay probe for each
available provider. Claude-only, Codex-only, and dual-provider installations
are valid. It prints `TELAEGENT IS CONNECTED` only after a normalized result
returns through the relay. Local paths, GitHub/provider credentials, raw CLI
output, and provider session IDs remain local.

The signed-in browser can poll
`GET /api/connectors/installations/:connectorInstanceId/status`. The backend
derives the user from the HttpOnly Telaegent session and returns only that
owner's credential lifecycle plus bounded, safe repository/binding metadata.
It returns no bearer, token hash, local path, remote URL, GitHub/provider
credential, or provider session. The response is non-cacheable. A `ready`
binding proves durable repository registration; `lastSeenAt` is telemetry, not
a promise that the process will remain online.

Transient network errors and HTTP 408/425/429/5xx responses reconnect with
jittered exponential backoff capped at 30 seconds. Authentication rejection is
terminal, so a revoked or rotated bearer cannot create an infinite retry loop.
The connector forwards structural progress only; raw provider text remains
local and only the bounded normalized result crosses the connector boundary.
After a backend restart, the first authenticated connector request restores a
ready binding from durable authorization state. Revoked, suspended, stale, and
unavailable bindings fail closed. This costs one bounded status lookup per
binding recovery, not one database call per poll.

This is still a source-tree proof command, not finished `npx telaegent`
packaging. OS credential-vault integration, installer/update signing, and
durable presence telemetry remain follow-up work. Credential issuance already
rotates the server-side hash and unregisters the old process-local principal,
but the local replacement must remain a deliberate user action until a secure
vault-backed installer owns it.

## Resource requests (design commitment, not built)

[Canonical build plan section 8](../../../../docs/product/canonical-build-plan.md)
extends the job envelope so a bounded follow-up loop can run: a job may carry
resource references, and a result may carry a request for resources the agent
does not yet hold. Nothing in this directory implements that yet;
`ConnectorJobRequest` has no resource field and `ConnectorJobResult` has no
request field.

When it is built, the same trust boundary applies. A resource crosses as an
**opaque resource ID** issued by the owning connector, never as a path. The
requesting side names an ID it was given; it cannot name a file. The owning
connector resolves the ID against its own registry, and its local policy engine
and file broker decide - the cloud relays, and neither side's agent is the
authorization authority.

Automatic service requires all of: same task, same peer, same exact resource,
read-only, an unexpired grant, and a canonical path inside the registered
project. Anything else returns a scope-expansion prompt to the owning human.
The follow-up loop is bounded by rounds, requests per round, and total bytes.
