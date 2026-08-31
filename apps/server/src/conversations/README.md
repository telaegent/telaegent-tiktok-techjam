# Canonical conversation API

This module is the cloud-product messaging lifecycle. It is intentionally
separate from the preserved Phoenix/conflict workflow under `src/telagent/`.

## Endpoints

| Method | Path | Effect |
| --- | --- | --- |
| `POST` | `/api/conversations/:conversationId/drafts` | Create an owner-private sender draft. |
| `POST` | `/api/conversations/:conversationId/replies` | Create an owner-private recipient draft answering an approved message. |
| `GET` | `/api/drafts/:draftId` | Read owner-private draft state and the reviewed candidate. |
| `POST` | `/api/drafts/:draftId/messages` | Add an owner clarification to a private draft. |
| `POST` | `/api/drafts/:draftId/run` | Start the authorized private provider turn; returns `202` and a poll URL. |
| `POST` | `/api/drafts/:draftId/cancel` | Cancel or discard an owner-private draft. |
| `POST` | `/api/drafts/:draftId/send` | Record exact human approval and atomically append one shared message. |
| `GET` | `/api/conversations/:conversationId/messages` | Read approved shared messages only. |

A draft carries a `role`. A `sender` draft starts from the owner's own rough
input; a `recipient` draft answers one approved collaborator message named by
`incomingMessageId`, with `roughMessage` demoted to optional steering. Beyond
creation the two are the same object and share every remaining endpoint, so a
reply crosses the trust boundary under exactly the same Send/Edit/No gate as a
message the owner started. `/replies` returns `409` when the named message is
absent, outside this conversation or repository, or was sent by the owner
themselves: an owner answers a collaborator, never their own message.

Each role has its own durable loader, and each rejects the other role's rows in
SQL. That check cannot be lifted into the adapter: `load_sender_protocol_context`
hardcodes `'role', 'sender'` in its own result, so a recipient row loaded through
it would arrive claiming to be a sender turn. It would also relocate the
collaborator's message from the untrusted data envelope into `sharedHistory`,
where the model reads it as trusted context. For the same reason the recipient
loader bounds shared history strictly before the message being answered: that
message reaches the model exactly once, inside the envelope.

Asynchronous provider or connector failures are returned by draft polling as
`state: "runtime_failed"` with a normalized `failure` object containing only a
public `code`, safe `message`, and `retryable` flag. Raw connector, provider,
path, credential, and process details never enter the draft response.

The authenticated user is injected by trusted server authentication. No route
accepts a user ID, local workspace path, connector binding, provider session ID,
sandbox policy, or turn budget from the browser.

`authentication/identity-service.ts` supplies the production resolver seam.
GitHub OAuth establishes the Telaegent account once; subsequent requests use an
opaque Telaegent session cookie whose SHA-256 hash is persisted in Supabase.
Supabase Auth JWTs, browser-provided user IDs, and the local connector's GitHub
credentials are never accepted as website identity. Missing, expired, revoked,
malformed, or unavailable sessions fail closed.

`send` requires an idempotency key. Durable repository adapters must commit the
approval, shared message, and draft state in one transaction. Human-edited
content is passed through the deterministic protocol guard again immediately
before that transaction.

Persistence is selected only through `CONVERSATION_PERSISTENCE`. It defaults to
`memory`, which is intended for tests and local composition and does not survive
a restart. `supabase` selects the durable adapter, whose ten RPCs each run as a
single transaction; `send_private_draft` is the only writer of shared messages,
so approval, message append, and draft state commit together or not at all. A
Supabase failure never falls back to memory: serving an empty transcript after
an outage would present canonical project memory as if it never happened.

The module is registered by the production bootstrap, which composes the
`authentication/` resolver into `createConversationApi` (`index.ts`). Absent that
seam the factory's own default is used, and it fails closed with 401 on every
route. Silently treating the legacy shared app token or a browser header as a
user identity would destroy the owner-private boundary.

`listMessages` has no cursor, so the durable adapter reads a bounded transcript
and asks for one message beyond it, so a conversation that has outgrown the
bound is refused rather than served as a silently truncated canonical memory.
Raising the bound is not the fix; a cursor on the repository interface is.
