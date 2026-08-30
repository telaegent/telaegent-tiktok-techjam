# Provider runtime evidence

**Owner:** Phuong
**Checked:** 2026-08-30
**Environment:** local Windows development machine

This memo separates observations from claims that still need proof through the
canonical local connector. Local authentication is directly relevant, but the
current server-side adapter does not prove connector binding, transport, or
cross-project isolation.

## Evidence status

| Check | Claude Code | Codex | Evidence level |
| --- | --- | --- | --- |
| CLI installed | `2.1.250` | `0.150.1` | Verified locally |
| CLI reports authenticated | Yes, Claude account auth | Yes, ChatGPT login | Verified locally without a model turn |
| Adapter capability check | Implemented | Implemented | Covered by automated runner tests |
| Real structured probe | Available through `demo:connections` | Available through `demo:connections` | Not run in this check; requires explicit approval for authenticated model use and possible cost |
| Fresh provider session | Adapter implemented | Adapter implemented | Covered with fakes; live proof pending |
| Resume from a new process | Adapter implemented | Adapter implemented | Live proof pending |
| Missing-session recovery | One-delete/one-recreate path implemented | One-delete/one-recreate path implemented | Automated proof passes; live script exists but live provider run is pending |
| Cancel, timeout, malformed output, output limit | Implemented and normalized | Implemented and normalized | Automated runner tests; clean-runtime proof pending |
| User x repository isolation | Not provided by the current local process runner | Not provided by the current local process runner | Blocked on connector binding and local path isolation implementation |

The live commands are intentionally not recorded as successful until they have
actually completed. The existing entry points are:

```text
npm run demo:connections -w @launchpad/server
npm run demo:session-recovery -w @launchpad/server
TELAEGENT_RECOVERY_PROVIDER=claude npm run demo:session-recovery -w @launchpad/server
```

Run them only with controlled provider accounts, a disposable repository, and
an explicitly selected provider home. Capture latency and pass/fail state, but
do not capture credentials, raw provider streams, prompts containing private
data, or provider session IDs.

## What the current adapters prove

- Both providers are launched without a shell and receive the prompt on stdin.
- The adapters can use a selected working directory; canonical connector jobs
  must not contain it, and the connector must resolve it from local binding.
- Runtime duration, idle time, and output size are bounded.
- Cancellation terminates the owned child process.
- Provider failures are normalized before crossing the runtime boundary.
- Provider session IDs are private, validated internal cache references.
- A missing session is deleted and recreated once after canonical context is
  rehydrated.

## What the current local process runner does not prove

- Claude inherits the server account's home-related environment.
- Codex uses one configured `CODEX_HOME` and also inherits the server account's
  general home environment.
- A connector-owned workspace path does not itself prevent the child process from
  reading other paths available to the same operating-system identity.
- A temporary probe workspace is not proof of local user × repository isolation.
- Local login persistence does not establish connector authentication,
  binding, revocation, or safe transport.

These are connector blockers, not reasons to move execution or credentials to
the cloud.

## Required connector-mediated proof

For each provider, record the following on supported local developer platforms:

1. CLI version and installation source.
2. Existing local authentication detected using a controlled account.
3. A structured, read-only turn succeeds in the bound repository.
4. A fresh CLI process reuses only the intended persisted authentication.
5. A session created by Telaegent resumes from a fresh process.
6. Removing only the session state produces a classified missing-session error
   and exactly one rehydrated fresh turn.
7. Cancellation, timeout, malformed output, and output-limit behavior match the
   normalized contract.
8. Repo A jobs cannot resolve Repo B or paths outside the locally registered
   workspace.
9. Revocation disables the connector binding before another turn can start;
   it does not require uploading or deleting the user's global CLI credential.
10. Cloud registration, job, progress, result, and audit payloads contain no
    local path, credential, provider session ID, or raw provider stream.

The proof result should name the connector version, operating system, provider
version, opaque binding ID, repository ID, and timings. It must not include
provider session IDs, local paths, repository contents, or secret material.
