# @telaegent/connector

The Telaegent connector runs on a developer's own machine. It binds one
deliberately selected Git repository to Telaegent, verifies local GitHub CLI
access, probes locally authenticated Claude Code and Codex CLIs, and maintains
an outbound connection to the Telaegent control plane.

From the repository you want to connect:

```bash
npx --yes @telaegent/connector@0.1.7 connect . \
  --url https://telaegent.live \
  --pair ONE_TIME_PAIRING_CODE
```

The Telaegent website generates a short-lived, single-use pairing code. The
connector exchanges it directly for its connector credential, so the durable
bearer never appears in the browser, clipboard, shell history, or process
arguments. The repository checkout, its local path, GitHub/provider
credentials, and provider sessions remain on this machine.

Run the command from the repository root. Before consuming the pairing code,
the connector prints the canonical local root and exact GitHub `owner/name`;
answer `y` only when both identify the repository you intended to connect.

Requirements:

- Node.js 22 or newer
- Git and an authenticated GitHub CLI (`gh`)
- an authenticated Claude Code CLI, Codex CLI, or both

Use `--provider claude` or `--provider codex` to restrict the local connector
to one provider. Use `--probe-only` to verify the live path and exit.
