# Cloud-to-local connector seam

> **Status: contract only.** `ConnectorTurnExecutor` defines this seam and is
> covered by its own tests, but it is not yet wired into a composition root.
> `createAuthorizedProtocolTurnRuntime` still composes the local
> `ProviderSessionManager` directly. Wiring the relay is the next step.

Canonical cloud orchestration is intended to dispatch an authorized, bounded,
path-free job through `ConnectorTurnExecutor`. A job contains an opaque
connector binding, stable repository scope, provider, purpose, bounded
prompt/context, schema name, correlation ID, execution budget, and the
authorized sandbox/network policy the connector must enforce locally.

It never contains a local path, executable, command, environment variable,
credential, provider-home location, or provider session ID. The owning local
connector validates the job and resolves its private binding-to-workspace and
provider mapping before invoking a local runner.

The existing Claude/Codex runners and `ProviderSessionManager` are local adapter
building blocks and test/research utilities currently colocated in the server
package. The cloud bootstrap leaves `ENABLE_LEGACY_LOCAL_PLAYGROUND=0` and must
not construct those runners. A future package move may relocate them without
changing this trust boundary.
