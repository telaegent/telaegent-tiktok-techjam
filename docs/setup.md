# Cross-platform setup

Telaegent supports Windows 10/11, current macOS, and current Linux distributions
on x64 or arm64 where Node.js 22 and the selected provider CLI are supported.
The application and setup tooling use Node APIs rather than Bash, PowerShell,
Homebrew, `apt`, or a particular container engine.

## One-command local setup

Install [Node.js 22 or newer](https://nodejs.org/) and Git, clone the repository,
then run this from the repository root:

```text
npm run setup
```

That single command:

1. verifies the operating system and Node version;
2. creates a private `.env` from `.env.example` when one does not exist;
3. generates the local secrets instead of leaving unsafe placeholders active;
4. installs the exact locked dependencies with `npm ci`;
5. builds the browser and control plane; and
6. reports every external prerequisite still missing for full end-to-end mode.

It never overwrites an existing `.env`, installs system software with elevated
permissions, signs into an account, or copies credentials into the repository.
Those actions require the developer or an external service and are listed
explicitly below.

To perform the same setup and immediately start the local browser and API:

```text
npm run up
```

Open `http://localhost:5173`. Stop both processes with Ctrl+C. The development
runner terminates both complete process trees, including npm children on
Windows, so the API and browser ports are not left occupied. Subsequent
development runs can use `npm run dev`; production-style local runs use
`npm run build` followed by `npm start` and open `http://localhost:3000`.

## Full end-to-end prerequisites

The complete two-user connector flow needs external identities and durable
storage. They cannot safely be invented or silently installed by a repository
script. Complete these one-time steps. `npm run doctor` checks their static
configuration and local command state; the browser-generated `npx` command
verifies the real repository/provider/relay path:

1. Create a Supabase project. Link it with the Supabase CLI and apply every
   committed migration:

   ```text
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase db push
   ```

2. Create a GitHub OAuth App for the browser identity. For local development,
   set its homepage to `http://localhost:5173` and callback URL to
   `http://localhost:5173/api/auth/github/callback`.
3. Set these values in the root `.env`:

   ```text
   TELAEGENT_IDENTITY_PROVIDER=github
   AUTHORIZATION_PERSISTENCE=supabase
   CONVERSATION_PERSISTENCE=supabase
   TELAEGENT_PUBLIC_URL=http://localhost:5173
   GITHUB_OAUTH_CLIENT_ID=...
   GITHUB_OAUTH_CLIENT_SECRET=...
   SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_...
   ```

   Keep the generated `TELAEGENT_COOKIE_SECRET`. Never use a publishable or
   browser key as `SUPABASE_SECRET_KEY`, and never commit `.env`.
4. Install GitHub CLI and authenticate locally with `gh auth login`.
5. Install and authenticate at least one local provider: Codex CLI or Claude
   Code CLI. Telaegent reuses that local login and never uploads it.
6. Run `npm run doctor`. It exits nonzero and lists missing static configuration,
   GitHub CLI authentication, connector configuration, or provider installation.
   It deliberately does **not** claim provider authentication, model access,
   repository proof, or relay routing are live merely because configuration exists.

Docker is not required for the canonical local connector. It is needed only if
you choose a Docker-backed local Supabase stack or maintain the preserved
legacy runtime POC.

## Start a connector

Normal users do not need a Telaegent source checkout. After the release owner
publishes `@telaegent/connector`, sign in at Telaegent, create a connector
pairing command, open a terminal in the repository to connect, and run the exact
command shown by the website:

```text
npx --yes @telaegent/connector@0.1.9 connect . --url https://telaegent.live --pair ONE_TIME_CODE
```

The pairing code is high-entropy, expires after five minutes, and can be used
only once. The connector exchanges it directly for the longer-lived connector
credential; that bearer never appears in browser state, the clipboard, shell
history, or process arguments.

The same command syntax works on Windows, macOS, and Linux. Run it from the
actual Git repository root: the connector rejects a nested folder that would
silently resolve to an ancestor checkout. It prints the canonical local root
and exact GitHub `owner/name`, then requires `y` before consuming the pairing
code. After confirmation it verifies local GitHub access, registers safe
repository metadata, runs a real provider probe, and begins outbound long
polling. No local path, credential, repository checkout, or provider session is
uploaded.

The Projects page separates repositories whose connectors are present in the
live relay from previous offline, stopped, or unverified connections. Durable
`ready` state alone is never presented as current connector presence.

The package is built with `npm run connector:package` and must be published
before a production frontend displays this command.

### Source-checkout development fallback

Source-checkout developers can use the same browser-issued pairing code without
waiting for npm publication. Build once, then replace the published-package
part of the displayed command with the local script:

```text
npm run connector:connect -- connect . --url http://localhost:3000 --pair ONE_TIME_CODE
```

The older ignored `connector.env` path remains available for low-level recovery
and `doctor:live`, but normal onboarding neither creates nor exposes a durable
connector bearer in the browser. The normal command already performs the real
provider and relay probe before it prints `TELAEGENT IS CONNECTED` and begins
long polling. Provider usage or cost may apply.

Each developer repeats the external identity and connector steps on their own
machine. A complete demo requires both connectors online, both users to have
proved the same stable GitHub repository ID, and the project connection to be
accepted in the browser.

## Commands and diagnostics

| Command | Purpose |
| --- | --- |
| `npm run setup` | Idempotent install, local config generation, build, and prerequisite report |
| `npm run up` | Run setup and start API plus browser |
| `npm run doctor` | Strict static/configuration preflight; never claims live readiness |
| `npm run doctor:live -- [workspace]` | Source-checkout fallback probe using `connector.env` |
| `npm run setup:check` | Platform-neutral setup self-check used by CI |
| `npm run check` | Typecheck, deterministic tests, and production build |
| `npm run connector:connect -- connect .` | Build and start the canonical local connector |

Provider authentication is validated only by the connector's real bounded
startup probe (or the source-only `doctor:live` fallback), not by setup finding an executable. If the probe
fails, authenticate the chosen CLI locally and rerun it.
