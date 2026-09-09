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
   If Caddy or another reverse proxy connects to Fastify, also set
   `TELAEGENT_TRUSTED_PROXY_CIDRS` to only that proxy's exact IP/CIDR so the
   public device-authorization limiters see the verified client IP. Leave it
   empty when Fastify is directly exposed.
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
publishes `@telaegent/connector`, install it once:

```text
npm install --global @telaegent/connector
```

Open a terminal at the exact repository root and run:

```text
tlg connect
```

On first use, the connector creates a high-entropy device code and future
connector bearer, sends only their hashes, and opens a short-lived approval page
in the signed-in Telaegent website. The approval expires after five minutes and
is terminal. Credential activation is atomic and retry-safe: repeating a poll
after a lost response only confirms the same precommitted bearer hash, including
during a one-minute consumed-only recovery window at the authorization deadline.
The browser and cloud never receive the raw bearer. After approval, the CLI
stores it in the operating-system credential vault rather than a file,
clipboard, shell history, or process argument.

The public authorization-creation route permits 10 requests per verified IP per
minute. The token route permits 120 because a legitimate connector polls every
three seconds. Random valid device codes are subject to that route limit before
they can create unbounded database traffic.

The same command syntax works on Windows, macOS, and Linux. The connector
shows both Claude Code and Codex with their local setup status, even if only
one is available. Choose one, both, or **Check again** after fixing local setup.
Pass `--provider claude`, `--provider codex`, `--provider both`, or
`--provider auto` to make that choice non-interactively. `both` requires both
CLIs to pass detection; `auto` selects whatever authenticated CLIs are available.
Run it from the actual Git repository root: the connector rejects a nested
folder that would silently resolve to an ancestor checkout. It prints the
canonical local root
and exact GitHub `owner/name`, then requires `y` before registering the
repository. After confirmation it verifies local GitHub access, registers safe
repository metadata, runs a real provider probe, and begins outbound long
polling. No local path, credential, repository checkout, or provider session is
uploaded.

To add Claude to an existing Codex connection, finish or cancel active agent
work, press Ctrl+C in the connector terminal, and rerun
`tlg connect --provider choose` from the same repository root. Choose **Both
providers**. Do not use `tlg disconnect` for this change; it revokes the binding
and active grants. The browser's **Manage coding agents** control is available
beside the composer and in project settings. It explains setup and refreshes
provider availability. New drafts can use either connected provider; existing
drafts remain attached to their original provider. A provider becoming
unavailable pauses new work until the owner reconnects it or chooses another.

If one live probe fails, the connector clearly reports partial connection and
keeps the successful provider available. `--probe-only` returns failure if any
selected provider fails, so a demo readiness check cannot hide partial success.

For a source-checkout demo before publishing the connector package, run from
this Telaegent checkout (replace the example path with the intended repo root):

```powershell
npm run connector:connect -- connect D:\secret --provider both
```

Release this fix as connector **0.2.3** and publish that package before deploying
the browser that pins it. Connector `0.2.1` was built from an unreleased branch
and is incompatible with production's `/ready` contract. Update existing
installations to `0.2.3`. Before calling the deployment verified, run the Windows
acceptance flow: Codex only →
both → Claude only on the same repository, a failed Claude probe while Codex
remains usable, and a new Claude private draft followed by human Send. Confirm
the shared history remains intact and no second connector process is required.

The Projects page separates repositories whose connectors are present in the
live relay from previous offline, stopped, or unverified connections. Durable
`ready` state alone is never presented as current connector presence.

Press Ctrl+C to stop the foreground connector temporarily. Run
`tlg disconnect` from the same exact repository root to suspend the local
binding and revoke repository-scoped runtime authority while preserving shared
project history and collaborator trust. `tlg auth status` inspects remembered
machine authorization; `tlg auth logout` revokes and removes it.

The package is built with `npm run connector:package`. Publishing is gated by
repository checks, package inspection, a two-machine signed-in acceptance run,
the protected `connector-release` GitHub environment, and npm trusted
publishing with provenance. Before enabling the workflow, an administrator must
create `connector-release`, require reviewers, add a custom deployment-branch
policy containing exactly `main`, and configure npm trusted publishing for
`telaegent/telaegent-tiktok-techjam`, `publish-connector.yml`, and the
`connector-release` environment. The workflow fails closed if the environment
or either protection rule is missing, and it refuses every ref except `main`.

### Source-checkout development fallback

Source-checkout developers can exercise the same device-authorization flow
without waiting for npm publication:

```text
npm run connector:connect -- connect . --url http://localhost:3000
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
| `npm run connector:connect -- connect .` | Build and start the source-checkout connector |
| `tlg connect` | Start the installed connector for the exact current repository root |
| `tlg disconnect` | Suspend the current repository binding and revoke its runtime authority |
| `tlg auth status` / `tlg auth logout` | Inspect or revoke remembered machine authorization |

Provider authentication is validated only by the connector's real bounded
startup probe (or the source-only `doctor:live` fallback), not by setup finding an executable. If the probe
fails, authenticate the chosen CLI locally and rerun it.
