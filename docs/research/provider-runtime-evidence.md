# Provider runtime evidence

**Owner:** Phuong
**Checked:** 2026-08-30
**Environment:** local Windows development machine

This memo separates observations from claims that still need a clean Linux or
cloud-runtime proof. Local authentication is useful adapter evidence, but it is
not evidence of production isolation.

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
| User x repository isolation | Not provided by the local process runner | Not provided by the local process runner | Blocked on runtime binding and cloud isolation implementation |

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
- The working directory is selected by the server request.
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
- A server-owned workspace path does not itself prevent the child process from
  reading other paths available to the same operating-system identity.
- A temporary probe workspace is not a cloud sandbox.
- Local login persistence does not establish the correct production credential
  mount, encryption, revocation, or retention design.

These are deployment blockers, not reasons to weaken the browser-first product
boundary.

## Required clean-runtime proof

For each provider, record the following in a clean Linux/container environment:

1. CLI version and installation source.
2. Authentication completed using a controlled account.
3. A structured, read-only turn succeeds in the bound repository.
4. A fresh CLI process reuses only the intended persisted authentication.
5. A session created by Telaegent resumes from a fresh process.
6. Removing only the session state produces a classified missing-session error
   and exactly one rehydrated fresh turn.
7. Cancellation, timeout, malformed output, and output-limit behavior match the
   normalized contract.
8. Attempts to read another user or repository runtime path fail at the
   operating-system or container boundary.
9. Revocation removes credentials and session state before another turn can
   start.

The proof result should name the image/runtime version, provider version,
binding ID, repository ID, and timings. It must not include provider session
IDs or secret material.
