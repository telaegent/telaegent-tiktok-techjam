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

The authenticated user is injected by trusted server authentication. No route
accepts a user ID, workspace path, runtime binding, provider session ID,
sandbox policy, or turn budget from the browser.

`send` requires an idempotency key. Durable repository adapters must commit the
approval, shared message, and draft state in one transaction. Human-edited
content is passed through the deterministic protocol guard again immediately
before that transaction.

The current adapter is in-memory and intended for tests/local composition. The
module is not registered by the production bootstrap until Supabase-backed
conversation persistence and a verified Telaegent user-session resolver are
wired. Silently treating the legacy shared app token or a browser header as a
user identity would destroy the owner-private boundary.
