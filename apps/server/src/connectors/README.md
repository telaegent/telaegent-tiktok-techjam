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

This is a source-tree proof command, not finished `npx telaegent` packaging.
Reconnect/backoff, durable presence telemetry, installer/update signing, and
recipient-side conversation orchestration remain follow-up work.

## Resource requests (loop closed end to end)

[Canonical build plan section 8](../../../../docs/product/canonical-build-plan.md)
extends the job envelope so a bounded follow-up loop can run: a job may carry
resource references, and a result may carry a request for resources the agent
does not yet hold.

The owner's half of that exists here. `resource-registry.ts` mints and resolves
opaque IDs on the local machine only, `resource-policy.ts` is the deterministic
decision function, `file-broker.ts` performs the contained read, and
`resource-exchange.ts` answers each request in a batch independently.
`ConnectorWorker` serves a `resource_request` delivery without ever launching a
provider: delivering a file is a reference-monitor operation, not an agent turn.
A connector with no registry configured refuses everything.

The asking half starts in the model's own answer. A recipient turn may emit
`resourceRequests`, the same two forms defined here and reused by the protocol
schema rather than restated, so the shape an agent is allowed to ask in is the
shape the owner's machine enforces. `ConnectorWorker` lifts those onto the
result envelope while still on the asking developer's own machine: each entry is
re-validated, one that does not parse is dropped rather than failing the turn,
and the answer itself is passed on exactly as written. Nothing there reaches a
file - a request names an identifier that other machine already minted, or
describes the file in words for its owner to read. The prompt also tells the
answering agent to answer anyway, because a question may go unapproved and a
turn that waited instead leaves its owner with nothing.

The cloud half routes. A job result may carry `resourceRequests`,
`LongPollConnectorJobRelay.exchangeResources` delivers a batch to the owning
connector ahead of any queued job, and `POST /api/connectors/jobs/:jobId/resources`
carries the answer back to the waiting caller. Approved bytes pass through the
relay in flight and are never cached, logged or stored; a batch whose outcomes do
not line up positionally with its requests is rejected rather than reinterpreted.

The loop now closes inside one turn. `capability/follow-up-coordinator.ts` spends
a round, asserts only the grants the record says a human already pressed, routes
the batch, and queues anything new for the owning human;
`capability/draft-follow-up.ts` anchors that round on the bounded task the
crossing message opened; and `ConversationService` runs the asking turn again
with the approved files in its prompt.

It has to be one turn. Approved bytes travel in flight and are never stored, so
the only place they can be used is the round that asked for them - a loop
spanning two requests would have to keep somebody else's file somewhere in
between. They ride in `runtimePrompt` and never in `persistedSummary`.

A round that brings nothing back ends the loop rather than retrying: the
questions are with a human at that point. Five rounds is the ceiling, held both
on the task row and in the process, so a runtime that never reached the database
still stops.

The same trust boundary applies throughout. A resource crosses as an
**opaque resource ID** issued by the owning connector, never as a path. The
requesting side names an ID it was given; it cannot name a file. The owning
connector resolves the ID against its own registry, and its local policy engine
and file broker decide - the cloud relays, and neither side's agent is the
authorization authority.

Automatic service requires all of: same task, same peer, same exact resource,
read-only, an unexpired grant, and a canonical path inside the registered
project. Anything else returns a scope-expansion prompt to the owning human.
The follow-up loop is bounded by rounds, requests per round, and total bytes.
