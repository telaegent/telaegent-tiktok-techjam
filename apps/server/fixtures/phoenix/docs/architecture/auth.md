# Authentication architecture

## Sessions

Every authenticated request carries an opaque session id. Sessions are created,
read and revoked exclusively through `SessionRepository`. Route handlers never
talk to the session store directly — swapping the backing store must not require
touching a route.

Two implementations exist:

- `FakeSessionRepository` — an in-memory map used by all tests. Deterministic,
  no external service.
- `RedisSessionRepository` — the production path. Keys are namespaced
  `phoenix:session:<id>` and carry a TTL equal to the configured session expiry,
  so expiry is enforced by the store rather than by application code.

## Expiry

`SESSION_TTL_SECONDS` is the single source of truth for session lifetime. The
Redis entry TTL and the `expiresAt` field on the returned `Session` are derived
from it together, so they can never drift apart.

## Logout

Logout removes the session key. It must be idempotent: revoking an id that is
already gone succeeds silently, because a user clicking "sign out" twice is not
an error.

## Device binding

Sessions may record the device they were created from. Today `deviceId` is
optional so that older clients keep working. It exists so that a future change
can bind a session to a device and invalidate the rest.
