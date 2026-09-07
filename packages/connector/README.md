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

On first use, the CLI opens a short-lived Telaegent browser approval page. Once
approved, the connector stores its machine credential in the operating-system
credential vault. The durable bearer never appears in the browser, clipboard,
shell history, or process arguments. The repository checkout, local path,
GitHub/provider credentials, and provider sessions remain on this machine.

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

The command detects locally authenticated providers before consuming the
pairing code. If exactly one is ready, it selects that provider automatically;
if both are ready, it asks whether to connect Claude Code, Codex, or both.
Use `--provider claude` or `--provider codex` to make the choice directly, or
`--provider auto` to select every authenticated provider without a prompt.
Use `--probe-only` to verify the live path and exit.

Press Ctrl+C to stop the foreground connector without revoking the repository.
Run `tlg disconnect` from the same repository root to revoke its active binding,
cancel its local-runtime work and grants, and preserve project conversation
history. Run `tlg auth status` to inspect the remembered machine authorization,
or `tlg auth logout` to revoke it and remove it from the operating-system vault.

`telaegent` remains an alias for `tlg` for compatibility.
