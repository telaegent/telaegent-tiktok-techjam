# Private runtime isolation requirements

**Owner handoff:** Phuong to Thai and Khoa
**Status:** required boundary; infrastructure mechanism remains open

This contract describes what a private Claude Code or Codex turn needs from the
cloud runtime. It does not authorize a browser to choose paths, credentials, or
runtime bindings.

## Resolution boundary

Khoa's authorization layer resolves the authenticated user, stable GitHub
repository ID, and conversation into server-owned runtime information. The
runtime layer accepts only that resolved binding.

```text
trusted authenticated user
  + stable GitHub repository ID
  + conversation ID
        -> authorization
        -> runtime binding
        -> isolated provider process
```

The browser may identify the repository and conversation it wants to use. It
must never supply or override:

- user ID;
- workspace path;
- runtime binding ID;
- provider home or session path;
- credential location;
- executable or raw command.

## Minimum isolation unit

The runtime filesystem and process boundary is **user x repository**. Two
repositories owned by the same user must not share provider session files,
working trees, temporary files, or unrestricted mounts. Two users must never
share a writable provider home.

Provider authentication may eventually use a per-user encrypted credential
source for usability, but it must be injected into an isolated user x
repository runtime. Sharing a host home directory is not acceptable.

## Runtime binding inputs

The infrastructure implementation must resolve these values from server-owned
records:

- opaque runtime binding ID;
- authenticated internal user ID;
- stable GitHub repository ID;
- canonical workspace path and checked-out revision;
- selected and authorized provider;
- isolated provider-home path or credential mount;
- isolated temporary directory;
- process identity/container identity;
- sandbox, network, timeout, output, CPU, memory, and process limits.

Conversation ID scopes provider-session lookup and durable rehydration. It does
not weaken the user x repository filesystem boundary.

## Persistence matrix

| State | Lifetime | Required behavior |
| --- | --- | --- |
| Telaegent conversation | Durable database | Authoritative approved shared memory |
| Repository workspace | Reconstructable or persistent per binding | Never selected from browser-provided paths |
| Provider credential | Persist only as required | Encrypted, owner-scoped, revocable, never logged |
| Provider session state | Private cache, user x repository and conversation scoped | May disappear; must rehydrate from Telaegent memory |
| Draft/tool output | Ephemeral or short-lived | Never shared before human Send; do not retain hidden reasoning |
| Temporary files | One runtime/turn | Removed after completion or runtime destruction |
| Safe audit events | Durable | IDs and state transitions only; no credentials or raw CLI streams |

## Process contract

Each turn starts a fresh CLI process inside the resolved runtime binding. The
runtime manager must:

- launch a fixed provider executable without a shell;
- set the canonical repository as the working directory;
- use an environment allowlist and replace all home/config/temp variables with
  binding-owned locations;
- mount only the selected repository and required provider state;
- apply read-only or workspace-write policy from the authorized turn purpose;
- bound total time, idle time, output bytes, CPU, memory, and child processes;
- terminate the whole owned process group on cancellation or timeout;
- prevent access to host paths, sibling bindings, and control-plane sockets;
- redact credentials and avoid persisting prompts or raw provider streams;
- return normalized failures without provider-private error text.

For Windows-hosted development, replacing only `HOME` is insufficient. The
runtime must also account for platform config roots such as `USERPROFILE`,
`APPDATA`, `LOCALAPPDATA`, and temp variables. Production proof should happen
in the actual Linux/container target.

## Lifecycle and revocation

The session manager exposes exact-scope invalidation. Infrastructure and
authorization integrations must invoke it when:

- a provider disconnects or reconnects;
- provider credentials rotate or expire;
- a runtime binding is destroyed or replaced;
- repository access is revoked;
- a conversation is deleted;
- the user explicitly clears provider context.

Revocation must prevent new turns first, cancel or finish in-flight work under
the agreed policy, then remove credentials and provider-session state. Deleting
a provider session must not delete the durable Telaegent conversation.

## Acceptance checks

The cloud runtime is ready for browser integration only when automated or
recorded proofs show:

- same binding can start a new process and reuse its authorized provider state;
- different user or repository bindings cannot read each other's workspace,
  provider home, temp files, credentials, or session data;
- a supplied path or runtime-binding value from an untrusted request is ignored
  or rejected;
- cancellation and timeout leave no provider child process running;
- runtime recreation retains only explicitly persistent state;
- repository/provider revocation prevents subsequent turns;
- loss of provider session state recreates once from durable Telaegent context.
