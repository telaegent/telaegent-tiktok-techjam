# Local connector execution requirements

**Owner handoff:** Phuong to Thai and Khoa
**Status:** required boundary; connector mechanism remains open

This contract describes what a private Claude Code or Codex turn needs from
the local connector. Telaegent cloud authorizes and routes bounded work; it
does not choose a local path, hold credentials, or launch a provider process.

## Resolution boundary

```text
trusted Telaegent user
  + stable GitHub repository ID
  + conversation ID
        -> cloud authorization
        -> opaque connector binding
        -> bounded connector job
        -> connector resolves registered local workspace/provider
        -> local provider process
```

The browser and cloud job must never supply or override:

- local user ID or operating-system identity;
- workspace/provider-home/session path;
- provider credential or credential location;
- executable, shell command, environment variable, or tool allowlist;
- another connector or repository binding.

## Minimum isolation unit

The execution boundary is **user × repository**. The cloud holds only an
opaque connector binding and safe status/metadata. The local connector holds
the private binding-to-workspace/provider mapping.

The connector must resolve every job against that mapping, canonicalize the
registered workspace, and reject path escapes or repository/binding mismatch.
Provider authentication may be per local user, but provider sessions, working
directory, temporary output, and project context must remain scoped so Repo A
cannot read or resume Repo B through a Telaegent job.

## Cloud connector binding

Cloud-owned fields may include:

- opaque connector binding ID;
- authenticated Telaegent user ID;
- stable GitHub repository/project ID;
- status and last-seen timestamp;
- supported provider availability;
- safe branch/commit metadata.

They must not include local paths, credentials, repository contents, provider
session IDs, provider homes, or arbitrary runtime configuration.

## Local connector state

Local-only state includes:

- binding ID -> canonical workspace mapping;
- selected provider and executable discovered from trusted local setup;
- local GitHub/provider authentication;
- provider session references/state;
- local temporary/tool output;
- cancellation handles for owned child processes.

## Process contract

For each accepted job, the connector must:

- authenticate and integrity-check the job, expiry, binding, user, repository,
  purpose, and correlation ID;
- accept only a fixed schema of purposes and policy values;
- resolve the working directory from local registration, never job text;
- launch a fixed locally discovered provider executable without a shell;
- use an environment allowlist and avoid printing credentials;
- enforce read-only or separately reviewed write policy for the job purpose;
- bound total time, idle time, output size, and child-process lifetime;
- terminate the owned process tree on cancellation or timeout;
- prevent path traversal and cross-project access;
- keep raw streams, tool output, hidden reasoning, and session IDs local;
- return only normalized progress and bounded structured candidate output.

Container or OS sandboxing may strengthen the local boundary, but the cloud
must not assume that every supported developer platform provides the same
sandbox. P0 messaging turns remain read-only and deterministic backend policy
still scans the candidate before it can be shared.

## Transport contract

The connector initiates outbound HTTPS/WebSocket/long-poll transport. No
inbound public port or peer-to-peer link is required. Delivery must define:

- connector authentication and key rotation;
- heartbeat/presence and offline state;
- monotonic/unique job IDs, acknowledgement, expiry, and deduplication;
- bounded queueing and reconnect/redelivery behavior;
- cancellation and late-result rejection;
- revocation before subsequent work;
- safe logs containing identifiers/status only.

## Persistence matrix

| State | Location/lifetime | Required behavior |
| --- | --- | --- |
| Approved Telaegent conversation | Cloud, durable | Authoritative shared memory |
| Connector binding/status | Cloud, durable/revocable | Opaque; no local path |
| Binding-to-workspace mapping | Local connector | Never uploaded |
| Repository/worktree | Local developer machine | Never selected from cloud input |
| GitHub/provider credential | Local developer machine | Never uploaded or logged |
| Provider session state | Local private cache | May disappear; rehydrate from bounded shared memory |
| Draft/job payload | Cloud transit or owner-private temporary state | Never shared before human `Send` |
| Raw provider/tool output | Local, ephemeral | Never persisted to shared cloud state |
| Safe audit events | Cloud, durable | IDs/states only; no paths, credentials, or streams |

## Lifecycle and revocation

Revocation must prevent new cloud jobs first. The connector rejects jobs for a
revoked/rotated binding and cancels or finishes in-flight work under the agreed
policy. Disconnecting a connector removes its local registration and cloud
binding but must not log the developer out of GitHub or a provider globally.

Provider session loss deletes/recreates only local cache. It must not delete
the durable approved Telaegent conversation.

## Acceptance checks

- a connector reconnects to the same authorized opaque binding;
- Repo A jobs cannot resolve Repo B or paths outside the registered workspace;
- cloud/browser payloads containing a path, executable, command, provider
  session ID, or credential field are rejected;
- connector registration/job/result payloads contain no local path,
  credential, repository content, or raw provider stream;
- cancellation and timeout leave no owned provider child running;
- offline/revoked connectors do not execute jobs or appear available;
- duplicate/expired/late jobs cannot create duplicate candidates or messages;
- provider session loss recreates once from bounded durable Telaegent context;
- candidates still require deterministic policy and the owning human's exact
  `Send` action before entering shared conversation state.
