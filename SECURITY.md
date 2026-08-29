# Telaegent Security and Trust Model

Telaegent is a hackathon proof of concept. The canonical repository is [telaegent/telaegent-tiktok-techjam](https://github.com/telaegent/telaegent-tiktok-techjam).

## Permission boundaries

1. **Telaegent identity:** who is signed in.
2. **Repository authorization:** which GitHub repositories the user deliberately connected.
3. **Project relationship:** who may exchange agent-assisted messages for that repository.
4. **Outbound disclosure:** the exact content the owning human approves with Send/Edit/No.

Passing one boundary never grants the next. A project connection permits requests, not direct repository access or automatic responses.

## Hard protection

Before shared delivery, deterministic policy must be able to block:

- `.env` and `.env.*` values
- private keys, API/access tokens, cloud and SSH credentials
- paths outside the selected repository
- another user's workspace, provider home, session, credentials, or private drafts
- hidden system prompts and raw provider streams

The agent may recommend a safe alternative such as environment-variable names or configuration structure. It cannot approve itself, change project authorization, or send automatically.

## Cloud custody

The browser-first architecture means Telaegent cloud may hold:

- repository checkouts
- GitHub delegated authorization
- Claude Code/Codex authorization and session state
- private drafts and temporary runtime context

Credential material requires stronger storage than ordinary product rows, such as Azure Key Vault, a protected encrypted volume, or another owner-isolated secret mechanism selected after research.

## Isolation requirements

- runtime boundary scoped to user x repository
- no shared unrestricted `$HOME`
- no cross-user or sibling-repository mounts
- no Docker socket exposed to agent runtimes
- remote messages cannot select host paths or executables
- bounded process resources, lifetime, output, and cancellation
- safe log redaction
- revocation and cleanup behavior

## Data handling

Durable:

- users, repositories, memberships, project connections
- approved shared messages
- exact approvals and safe audit events
- safe runtime/provider status and compact conversation memory

Protected/private:

- GitHub/provider auth and provider session state
- private draft state visible only to its owner

Ephemeral by default:

- raw CLI streams
- internal prompts and temporary tool output
- rejected drafts and transient build artifacts

Never intentionally store hidden chain-of-thought or raw blocked secrets.

## Honest limitations

Do not claim:

- repositories or provider credentials never reach Telaegent cloud
- zero knowledge or end-to-end encryption
- production-grade multi-tenant isolation
- that a fresh shell creates a fresh identity/session
- that provider terms permit every hosted automation pattern

Use controlled demo accounts and repositories until cloud authentication, isolation, retention, revocation, and provider-policy questions are resolved.

## Legacy scaffold

The source tree still contains inherited ModelArk/Volcengine and fixed-workflow code for preservation and build continuity. It is not the canonical trust architecture. Standalone retired material is catalogued under `unused-code/`.

## Reporting

Report a vulnerability privately to the repository owner or event organizer with the affected revision, reproduction steps, impact, and suggested mitigation. Never put credentials, personal data, or exploit secrets in a public issue.
