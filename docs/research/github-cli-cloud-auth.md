# GitHub CLI Cloud Authentication Experiment

**Status:** Completed historical experiment; architecture conclusion superseded
**Date:** 2026-08-30  
**Owner:** Khoa  
**Branch:** `khoa.dao`

> [!IMPORTANT]
> This document preserves experiment evidence only. As of 2026-08-30, the
> canonical product uses the developer's existing **local** GitHub CLI through
> an outbound connector. Telaegent cloud does not run `gh`, clone repositories,
> or store GitHub credentials. Do not use this experiment as an implementation
> plan.

## Goal

Validate the P0 hypothesis that a cloud-like Linux runtime can start GitHub
CLI's browser/device authentication, surface a safe verification URL and
one-time code, persist only the owning user's authentication state, reuse it
from a new process, configure Git credentials, and access repositories using
that user's GitHub identity.

This experiment does not claim production-grade isolation. It is a local WSL2
Linux proof used to discover the exact CLI behavior before an Azure runtime is
selected.

## Superseded Azure reproduction handoff

The NUS Azure account available to Khoa authenticated successfully but was
denied resource access by tenant Conditional Access. That policy must not be
bypassed. The Azure reproduction is no longer planned: the canonical
architecture keeps GitHub CLI authentication on the developer's own machine, so
there is nothing left for a cloud run to prove. Telaegent's control plane is
assigned to AWS EC2, which hosts no GitHub CLI identity.

The reproducible proof package is documented at
[`deploy/azure/github-auth-proof/README.md`](../../deploy/azure/github-auth-proof/README.md).
It provisions one short-lived Ubuntu VM and restricted network resources in a
new, dedicated resource group. Khoa supplies only an SSH public key, then uses
the matching private key locally to perform GitHub device authorization with
Khoa's own GitHub account.

Before it was retired, the package passed local PowerShell, YAML, embedded Bash,
and Bicep compilation checks. This validates only the preserved package's syntax
and internal contract, not Azure provisioning or runtime behavior. No live
deployment is required or planned under the canonical architecture.

## Environment

| Item | Observed value |
| --- | --- |
| Linux environment | Ubuntu on WSL2 |
| Kernel | `6.6.114.1-microsoft-standard-WSL2` |
| Linux user | unprivileged user, UID 1000 |
| Git | `2.53.0` |
| GitHub CLI | `2.98.0`, released 2026-08-20 |
| GitHub CLI source | official `cli/cli` GitHub release |
| Artifact verification | official checksum file; `sha256sum --check --strict` passed |

The experiment uses a dedicated private directory with mode `0700`. Both
`HOME` and `GH_CONFIG_DIR` point inside it so the test cannot silently reuse the
developer's ordinary GitHub CLI configuration.

## Results

### 1. Clean unauthenticated baseline — passed

With isolated `HOME` and `GH_CONFIG_DIR`, `gh auth status` reports:

```text
You are not logged into any GitHub hosts.
```

No GitHub host credential file exists at baseline.

### 2. Ephemeral storage behavior — confirmed

WSL clears `/tmp` when the distribution fully stops. A GitHub CLI binary and
configuration placed there did not survive the next WSL start.

Historical implication for the superseded cloud-runtime hypothesis: an
ephemeral runtime filesystem could not provide "connect once" behavior. The
canonical product instead reuses the developer's existing local GitHub CLI
authentication; Telaegent does not create, copy, or rehydrate that credential.

### 3. Browser/device flow initiation — passed

The tested command is:

```bash
gh auth login --hostname github.com --web --git-protocol https
```

Observed interaction:

1. GitHub CLI asks whether Git should authenticate with the GitHub credentials.
2. After confirmation, it prints a one-time device code.
3. It instructs the user to open `https://github.com/login/device`.
4. When no browser opener exists in the Linux runtime, the CLI prints a safe
   fallback message and continues waiting for authorization.

At the time, this supported a proposed browser-mediated cloud login. That UX is
superseded. The user now authenticates GitHub CLI locally outside Telaegent, and
the connector reports only bounded authentication status; it never relays a
device code or raw terminal output through the cloud.

Before authorization completes, the isolated home contains a mode-`0600`
GitHub CLI `device-id` state file but no host credential file.

### 4. Credential persistence and storage — passed with a security warning

After device authorization:

- `gh auth status` succeeded in multiple new processes;
- the authenticated GitHub login and numeric user ID were confirmed through
  `gh api user`;
- `gh auth setup-git` succeeded;
- the isolated global Git configuration delegates HTTPS credentials to
  `gh auth git-credential`;
- a full `wsl --terminate Ubuntu` followed by a new WSL start retained the
  authenticated identity and repository access.

This WSL environment did not provide a usable system credential store. GitHub
CLI emitted:

```text
Authentication credentials saved in plain text
```

The credential is stored in the isolated `GH_CONFIG_DIR/hosts.yml` file. The
file is owned by the test user with mode `0600`, but it still contains a raw
OAuth credential. File permissions reduce accidental access; they do not turn
an ordinary persistent volume into an acceptable production secret store.

Historical conclusion: process and runtime restart persistence was technically
proven for the isolated experiment, but production cloud custody would have
required a protected credential layer. The canonical local-connector design
avoids that custody entirely: the developer's GitHub CLI owns and persists its
credential locally, outside Telaegent.

### 5. Repository discovery and proof — passed for the controlled account

Safe metadata-only calls were tested before any clone:

```bash
gh api user
gh api user/repos --paginate
gh api repos/OWNER/REPOSITORY
```

Persist the numeric repository ID and verify access using the invitee's own
credential. Do not treat repository name, URL, invitation possession, or
frontend state as proof.

Observed repository discovery counts for the controlled account:

| Discovery path | Count |
| --- | ---: |
| Authenticated-user API, all requested affiliations | 19 |
| Owned | 5 |
| Direct collaborator | 11 |
| Organization member | 3 |
| `gh repo list --limit 1000` | 5 |

This empirically confirms that `gh repo list` alone is not a universal
repository picker for Telaegent. The authenticated-user repository API found
14 additional repositories available through collaboration or organization
membership.

The current private organization repository was resolved successfully:

```text
full name: telaegent/telaegent-tiktok-techjam
numeric GitHub repository ID: 1345851083
default branch: main
```

Requesting the older remote name `telaegent/telaegent-codejam` resolved to the
current canonical full name. This is direct evidence for storing GitHub's
stable numeric repository ID instead of treating `owner/name` as immutable.

## Security observations

- `gh auth login` documentation states that it prefers the system credential
  store and falls back to plaintext configuration when a credential store is
  unavailable.
- `--insecure-storage` must not be used by Telaegent.
- Authentication state must never share a `HOME`, `GH_CONFIG_DIR`, credential
  store, or mounted volume across users.
- The fixed verification URL and one-time code are safe to surface; command
  output still requires an allowlisted parser.
- Device authorization is sensitive delegated access even though no personal
  access token is pasted into Telaegent.

## Remaining gates

1. ~~Run and clean up the prepared Azure VM proof.~~ Dropped. GitHub CLI
   authentication is local under the connector architecture, so no cloud
   reproduction is required.
2. Prove connector repository registration and logs contain no token,
   `hosts.yml`, environment value, local path, or raw GitHub CLI output.
3. Test private, organization, collaborator-not-owner, and SSO-controlled
   repositories using controlled demo accounts.
4. Test revocation, `reconnect_required`, cleanup, and cross-user isolation.
5. Prove one connector principal or repository binding cannot reuse another
   user's proof, binding, credential, or repository authorization.
6. Validate connector packaging, transport authentication, reconnect, and
   local credential-file permissions before production.

## Current decision

The experiment proves only that GitHub CLI device authentication and persistence
worked in the isolated Linux environment, and that repository discovery must use
the authenticated-user API and stable numeric repository IDs.

It does not define Telaegent login or deployment. The canonical product uses
each developer's existing local GitHub CLI identity through an outbound local
connector. Telaegent's cloud never starts `gh auth login`, relays its device
flow, stores or rehydrates its credential, clones the repository, or runs GitHub
CLI. Production acceptance remains gated on local connector isolation,
repository-proof revocation, reconnect, credential non-disclosure, and
cross-user/cross-repository denial tests.

## Experiment cleanup

After recording the restart and repository-access evidence:

1. `gh auth logout --hostname github.com --user <controlled-user>` removed the
   local GitHub host authentication configuration.
2. A follow-up `gh auth status` confirmed that the isolated environment was no
   longer authenticated.
3. The dedicated WSL experiment directory, including its plaintext credential
   file and downloaded CLI binary, was removed.

GitHub CLI explicitly states that local logout does not revoke the OAuth token
server-side. Revoking the GitHub CLI OAuth application from GitHub settings
would revoke all GitHub CLI tokens across the user's devices, so that broad
account-wide action was intentionally not performed as part of this isolated
test.
