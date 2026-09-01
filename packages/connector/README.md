# @telaegent/connector

The Telaegent connector runs on a developer's own machine. It binds one
deliberately selected Git repository to Telaegent, verifies local GitHub CLI
access, probes locally authenticated Claude Code and Codex CLIs, and maintains
an outbound connection to the Telaegent control plane.

From the repository you want to connect:

```bash
npx @telaegent/connector connect . \
  --url https://telaegent.live \
  --instance-id CONNECTOR_INSTANCE_ID \
  --credential CONNECTOR_CREDENTIAL
```

The Telaegent website generates the installation ID and credential. The
repository checkout, its local path, GitHub/provider credentials, and provider
sessions remain on this machine.

Requirements:

- Node.js 22 or newer
- Git and an authenticated GitHub CLI (`gh`)
- an authenticated Claude Code CLI, Codex CLI, or both

Use `--provider claude` or `--provider codex` to restrict the local connector
to one provider. Use `--probe-only` to verify the live path and exit.
