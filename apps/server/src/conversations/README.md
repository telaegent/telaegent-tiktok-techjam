# Canonical conversation API

This module is the cloud-product messaging lifecycle. It is intentionally
separate from the preserved Phoenix/conflict workflow under `src/telagent/`.

## Endpoints

| Method | Path | Effect |
| --- | --- | --- |
| `POST` | `/api/conversations/:conversationId/drafts` | Create an owner-private sender draft. |
| `GET` | `/api/drafts/:draftId` | Read owner-private draft state and the reviewed candidate. |
| `POST` | `/api/drafts/:draftId/messages` | Add an owner clarification to a private draft. |
| `POST` | `/api/drafts/:draftId/run` | Start the authorized private provider turn; returns `202` and a poll URL. |
| `POST` | `/api/drafts/:draftId/cancel` | Cancel or discard an owner-private draft. |
| `POST` | `/api/drafts/:draftId/send` | Record exact human approval and atomically append one shared message. |
| `GET` | `/api/conversations/:conversationId/messages` | Read approved shared messages only. |

Asynchronous provider or connector failures are returned by draft polling as
`state: "runtime_failed"` with a normalized `failure` object containing only a
public `code`, safe `message`, and `retryable` flag. Raw connector, provider,
path, credential, and process details never enter the draft response.

The authenticated user is injected by trusted server authentication. No route
accepts a user ID, local workspace path, connector binding, provider session ID,
sandbox policy, or turn budget from the browser.

`send` requires an idempotency key. Durable repository adapters must commit the
approval, shared message, and draft state in one transaction. Human-edited
content is passed through the deterministic protocol guard again immediately
before that transaction.

Persistence is selected only through `CONVERSATION_PERSISTENCE`. It defaults to
`memory`, which is intended for tests and local composition and does not survive
a restart. `supabase` selects the durable adapter, whose nine RPCs each run as a
single transaction; `send_private_draft` is the only writer of shared messages,
so approval, message append, and draft state commit together or not at all. A
Supabase failure never falls back to memory: serving an empty transcript after
an outage would present canonical project memory as if it never happened.

The module is registered by the production bootstrap, but per-user identity is
still unresolved, so every route fails closed with 401 until a verified
Telaegent user-session resolver is composed. Silently treating the legacy shared
app token or a browser header as a user identity would destroy the owner-private
boundary.

`listMessages` has no cursor, so the durable adapter reads a bounded transcript
and asks for one message beyond it, so a conversation that has outgrown the
bound is refused rather than served as a silently truncated canonical memory.
Raising the bound is not the fix; a cursor on the repository interface is.
