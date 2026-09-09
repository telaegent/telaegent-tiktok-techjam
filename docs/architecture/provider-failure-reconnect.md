# Provider failure and reconnect behavior

**Owner handoff:** Phuong to backend and frontend

**Status:** lifecycle, normalized owner-safe failures, draft polling, explicit
provider recovery, cancellation, and restart reconciliation are implemented;
packaged two-machine validation remains open

Provider text must never determine product state. The local connector
normalizes provider behavior; the backend validates that bounded result,
updates safe connector/provider state, and returns server-selected actions.
Telaegent never silently switches providers.

## Provider connection states

```text
not_connected -> connecting -> connected
       ^             |             |
       |             v             v
       +------ unavailable   reconnect_required
                    |             |
                    +-> retry     +-> reconnect -> connecting
```

- `not_connected`: connector/provider registration does not exist.
- `connecting`: one deduplicated live probe is active.
- `connected`: the online local binding passed a live provider probe.
- `reconnect_required`: local authentication is absent or expired; the user
  signs in locally and asks the connector to probe again.
- `unavailable`: connector offline, CLI installation, provider availability,
  or a non-auth probe failed.

Installation and an auth-status command alone must not produce `connected`.

## Private turn terminal states

```text
queued -> running -> completed
                  -> failed
                  -> timed_out
                  -> cancelled
```

Exactly one terminal event is published. A provider's early completion signal
is not terminal until structured output parsing and private session persistence
also succeed. A failed turn never creates or sends a shared message candidate.

## Failure decisions

| Normalized code | Product result | Provider/session effect | Recommended allowed actions |
| --- | --- | --- | --- |
| `RUNTIME_AUTHENTICATION_FAILED` | Failed; local provider reconnect required | Connector invalidates its local private provider session | `reconnect_provider`, `dismiss` |
| `RUNTIME_SESSION_NOT_FOUND` | Recover internally once | Delete stale session, rehydrate durable context, start fresh | No user action if recovery succeeds; otherwise use the replacement failure |
| `RUNTIME_UNAVAILABLE` | Failed; provider unavailable | Keep durable conversation; do not silently switch provider | `retry`, `dismiss` |
| `RUNTIME_TIMEOUT` | Timed out | Do not create a candidate; session reuse is provider-dependent and should be invalidated if process state is uncertain | `retry`, `edit_request`, `dismiss` |
| `RUNTIME_OUTPUT_LIMIT` | Failed | Do not persist raw oversized output or create a candidate | `edit_request`, `dismiss` |
| `INVALID_AGENT_OUTPUT` | Failed | Reject output; discard an invalid returned session ID | `retry`, `edit_request`, `dismiss` |
| `UNSUPPORTED_RUNTIME_POLICY` | Blocked before useful execution | No provider connection change | `edit_request`, `dismiss` |
| `RUNTIME_FAILED` | Failed | Preserve durable context; invalidate session only when runtime integrity is uncertain | `retry`, `dismiss` |
| `RUNTIME_CANCELLED` | Cancelled | No candidate; clean up the owned process | `dismiss` |

The server, not the browser, selects `allowedActions`. Draft polling exposes
`state: "runtime_failed"` with only the normalized public code, safe message,
and retryability/action information. Raw provider, process, credential, path,
and session details remain local and never enter the browser payload.

## Missing-session recovery

```text
continue private provider session
        -> provider reports session missing
        -> connector deletes exact local user/repository/conversation/provider cache entry
        -> hydrate once from durable Telaegent context
        -> start one fresh provider session
        -> success, or surface the fresh attempt's normalized failure
```

There is no second recovery loop. Provider session IDs remain local to the
connector and must not appear in cloud jobs, results, progress events, logs,
browser payloads, or public errors.

## Reconnect and revocation

Reconnect is explicit. After the developer updates credentials locally, the
connector invalidates the affected local session cache and performs a
successful probe before the backend marks safe provider status connected again.

Repository revocation, provider disconnect, runtime replacement, conversation
deletion, and explicit context clearing invalidate the relevant private session
scope. Durable approved conversation history is retained according to product
policy and remains the source for later rehydration.

## Backend restart

Durable conversations and draft states survive a backend restart; active relay
registrations and provider processes do not. Production startup lists only
fully scoped `agent_working` drafts and reconciles them to an owner-visible
`runtime_failed` state explaining that nothing was sent. The backend never
fabricates completion or resumes the dead process. Provider session references
are never recovered by the cloud backend; a connector may reuse one only when
its owner scope and binding remain valid.
