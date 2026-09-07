# @telaegent/connector

The Telaegent connector runs on a developer's own machine. It binds one
deliberately selected Git repository to Telaegent, verifies local GitHub CLI
access, probes locally authenticated Claude Code and Codex CLIs, and maintains
an outbound connection to the Telaegent control plane.

Install the CLI once:

```bash
npm install --global @telaegent/connector
```

Then open a terminal at the exact root of the repository you want to connect:

```bash
tlg connect
```

On first use, the CLI creates the future bearer locally, sends only its hash,
and opens a short-lived Telaegent browser approval page. Once approved, the
connector stores that credential in the operating-system credential vault.
Retrying a lost approval response confirms the same hash without minting a new
credential, including during a one-minute consumed-only recovery window at the
authorization deadline. The raw bearer never appears in the browser, cloud,
clipboard, shell history, or process arguments. The repository checkout, local
path, GitHub/provider credentials, and provider sessions remain on this machine.

Run the command from the repository root. Before connecting,
the connector prints the canonical local root and exact GitHub `owner/name`;
answer `y` only when both identify the repository you intended to connect.
While it remains running, the connector refreshes its repository-access proof
every five minutes and after a control-plane reconnection. These bounded,
single-flight checks keep the website authorization lease fresh without
blocking agent job polling.

Requirements:

- Node.js 22 or newer
- Git and an authenticated GitHub CLI (`gh`)
- an authenticated Claude Code CLI, Codex CLI, or both

The command always shows both coding CLIs and their local setup status before
consuming a pairing code or authorizing this machine. Choose Claude Code, Codex,
or both. If a check fails, fix the CLI in another terminal and choose **Check
again**, or cancel. Authentication checks alone do not mean connected: each
selected provider must pass the live probe. After the connector owns the local
repository-binding lock, it clears the previous run's advertised provider set
before probing, so failed replacement probes cannot leave stale availability in
the browser.
Use `--provider claude` or `--provider codex` to make the choice directly,
`--provider both` to require both CLIs, or `--provider auto` to select whatever
authenticated CLIs are available without a prompt. If one of two live probes
fails, the connector reports partial success and serves only the successful
provider. `--probe-only` exits unsuccessfully unless every selected provider
passes its live probe.

To add or change providers on an existing repository, finish or cancel active
agent work, press Ctrl+C in its connector terminal, then run:

```bash
tlg connect --provider choose
```

Choose **Both providers** to keep Codex and add Claude. Keep the connector
running, then use **Manage coding agents → Check connection again** in the
browser. Choose the provider for a new draft; existing private drafts retain
their original provider. Do not run a second connector for the same binding or
use `tlg disconnect` for this change: disconnect revokes the repository binding
and its active grants. Machine authorization is reused when it is still valid.

Press Ctrl+C to stop the foreground connector without revoking the repository.
Run `tlg disconnect` from the same repository root to revoke its active binding,
cancel its local-runtime work and grants, and preserve project conversation
history. Run `tlg auth status` to inspect the remembered machine authorization,
or `tlg auth logout` to revoke it and remove it from the operating-system vault.

`telaegent` remains an alias for `tlg` for compatibility.
