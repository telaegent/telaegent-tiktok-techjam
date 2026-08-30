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

## Local custody and cloud transit

The browser-first product still uses local execution. Telaegent cloud may hold:

- approved shared messages and compact shared memory
- project identity, permissions, connector presence, and safe audit events
- bounded private draft/job payloads while they are being routed

Telaegent cloud must not hold repository checkouts, GitHub/provider credentials,
provider home directories, provider sessions, raw local tool output, or hidden
reasoning. If a private draft transits the cloud for the browser experience, it
remains owner-private and does not become durable shared state until `Send`.

## Isolation requirements

- connector binding scoped to user x repository
- local workspace resolved from connector registration, never from a cloud job
- no cross-project path traversal or sibling-repository access
- remote messages cannot select local paths, executables, or arbitrary commands
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

- private draft state visible only to its owner while transiting/stored by the product

Local-only:

- GitHub/provider auth and provider session state
- repositories, provider homes, and raw tool output

Ephemeral by default:

- raw CLI streams
- internal prompts and temporary tool output
- rejected drafts and transient build artifacts

Never intentionally store hidden chain-of-thought or raw blocked secrets.

## Honest limitations

Do not claim:

- that a connector can execute while the developer machine is offline
- zero knowledge or end-to-end encryption
- perfect local sandboxing across every supported provider/tool
- that a fresh shell creates a fresh identity/session
- that provider terms permit every connector-driven automation pattern

Use controlled demo accounts and repositories until connector authentication,
local isolation, retention, revocation, and provider-policy questions are
resolved.

## Legacy scaffold

The source tree still contains inherited ModelArk/Volcengine and fixed-workflow code for preservation and build continuity. It is not the canonical trust architecture. Standalone retired material is catalogued under `unused-code/`.

## Reporting

Report a vulnerability privately to the repository owner or event organizer with the affected revision, reproduction steps, impact, and suggested mitigation. Never put credentials, personal data, or exploit secrets in a public issue.
