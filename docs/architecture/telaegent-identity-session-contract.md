# Telaegent website identity and session contract

## Boundary

GitHub OAuth establishes who owns a Telaegent website account. It does **not**
prove that the person may use a repository, connector, local checkout, or coding
agent. Repository access remains a separate local GitHub CLI proof associated
with a user × stable GitHub repository ID binding.

Supabase is persistence only. The browser never presents a Supabase Auth JWT,
never receives a Supabase secret key, and never calls these identity tables or
RPCs directly.

## Sign-in flow

1. `GET /api/auth/github/start` creates 256-bit OAuth state and PKCE verifier.
2. The backend stores only the SHA-256 state hash, expiry, and a same-origin
   return path. The verifier is held in a signed, ten-minute, HttpOnly,
   SameSite=Lax callback cookie.
3. GitHub returns an authorization code and state to the fixed callback URL.
4. The backend validates the signed cookie and state, atomically consumes the
   state record, and exchanges the code with PKCE.
5. The access token is used once to call `GET /user`. The stable numeric GitHub
   user ID and current login/avatar are retained; the OAuth access token is not.
6. The backend creates 256 bits of session entropy, stores only its SHA-256
   hash, and sends the raw value in an HttpOnly, SameSite=Lax cookie. Production
   uses a Secure `__Host-` cookie.

The default session lasts 14 days and can be configured from one hour to 30
days. A returning browser reuses that Telaegent session and does not need a new
GitHub authorization while it remains active. Logout revokes the stored hash
and expires the cookie. Disabled/deleted accounts cannot create or use sessions.

Use a dedicated GitHub OAuth App for website identity. Telaegent requests no
OAuth scopes and rejects a token response that contains any scope, so this flow
cannot silently become a cloud repository-access mechanism.

## Persistent records

- `user_accounts`: Telaegent account lifecycle and internal UUID.
- `account_github_identities`: one stable GitHub user identity per account.
- `github_oauth_states`: short-lived, single-use hashed OAuth state.
- `web_sessions`: hashed Telaegent browser sessions and revocation/expiry.
- `github_connections`: separate local connector/GitHub CLI proof; never a
  browser login session and never populated merely by website OAuth.

All tables have RLS enabled, no browser policies, and no `anon` or
`authenticated` access. Narrow RPC execution is granted only to `service_role`.
Modern `sb_secret_...` keys are sent only as the backend `apikey` header and are
excluded from serialization and request logs.

## Request contract

- `GET /api/auth/session` returns either unauthenticated state or the current
  Telaegent user DTO; it never returns a session token.
- Cookie-authenticated conversation routes derive `authenticatedUserId` from
  the active session and never accept it in browser input.
- `POST /api/auth/logout` requires the configured same origin.
- Missing, malformed, expired, revoked, database-unavailable, or disabled
  identity state fails closed with bounded, non-sensitive errors.

OAuth state is stored centrally rather than in process memory, and session
lookups are stateless at the API tier. Multiple control-plane instances can
therefore serve the same deployment without sticky sessions.

Run `prune_telaegent_identity_records` from a backend-only scheduled job (daily
is sufficient for the MVP) to delete expired OAuth states and session rows that
have been expired or revoked for seven days. The expiry indexes keep both live
lookups and cleanup bounded as the account count grows.
