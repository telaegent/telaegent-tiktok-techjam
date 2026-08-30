# Cloud-to-local connector seam

> **Status: composed, transport pending.** `createAuthorizedProtocolTurnRuntime`
> takes either a `connector` relay (canonical cloud) or a `runtime` +
> `sessionStore` pair (connector-side/local, dev scripts, tests). The cloud
> composition builds no `ProviderSessionManager`. What does not exist yet is a
> `ConnectorJobRelay` implementation: the outbound WebSocket/long-poll
> transport and connector presence tracking are still to be built.

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
