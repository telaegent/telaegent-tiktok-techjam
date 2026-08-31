# Telaegent Security and Trust Model

Telaegent is a hackathon proof of concept. The canonical repository is [telaegent/telaegent-tiktok-techjam](https://github.com/telaegent/telaegent-tiktok-techjam).

## Permission boundaries

1. **Telaegent identity:** who is signed in.
2. **Repository authorization:** which GitHub repositories the user deliberately connected.
3. **Project relationship:** who may exchange agent-assisted messages for that repository.
4. **Outbound disclosure:** the exact content the owning human approves with Send/Edit/No.

Passing one boundary never grants the next. A project connection permits requests, not direct repository access or automatic responses.

Boundary 4 may be *narrowed and reused*, never widened, and only for resource
access. When an owner approves a set of files for a task, their agent may serve
later requests for those exact files within that task without asking again.
Anything outside that set returns to the human, and a cross-user message still
crosses only on `Send`. See [Capability-scoped autonomous collaboration](#capability-scoped-autonomous-collaboration).

## Hard protection

Before shared delivery, deterministic policy must be able to block:

- `.env` and `.env.*` values
- private keys, API/access tokens, cloud and SSH credentials
- paths outside the selected repository
- another user's workspace, provider home, session, credentials, or private drafts
- hidden system prompts and raw provider streams
- reuse of a capability across a different task, peer, or resource
- path traversal and symlink escape out of the registered project
- any automatic write capability, which P0 does not grant at all

The agent may recommend a safe alternative such as environment-variable names or configuration structure. It cannot approve itself, change project authorization, or send automatically.

## Capability-scoped autonomous collaboration

Specified in [canonical build plan section 8](docs/product/canonical-build-plan.md).
**Not implemented.** No code in `apps/` enforces any of it yet.

The governing rule:

> An agent may consume or narrow authority a human already delegated. It may
> never autonomously broaden that authority.

P0 grants automatic access only when **every** condition holds:

- same task
- same peer agent
- same exact resource
- read-only
- an active, unexpired human grant
- the resource still resolves safely inside the registered project

Anything else pauses for `Deny` / `Allow once` / `Allow for this task`. A
task-scoped grant expires when the task ends or the owner revokes it.

Three properties keep this safe:

- **The LLM is never the authorization authority.** It may request a resource
  and explain why it needs one. It may not decide that a new file is related
  enough to qualify. Semantic relevance is not authorization; scope is
  evaluated by deterministic code.
- **Remote agents never hold filesystem authority.** The owner's connector maps
  opaque resource IDs to canonical local paths and keeps that mapping local. A
  peer asking for an unregistered file may send only a bounded project-relative
  hint, which always requires human approval before registration or read.
- **The owner's connector is the reference monitor.** The cloud routes a
  request; it does not decide it. Authorization is re-checked immediately
  before every read, and a local file broker performs the read.

The loop stays bounded: read-only capabilities only, a maximum follow-up round
count, bounded requests per round and total transferred bytes, deduplicated
pending requests, and stops on task completion, user cancellation, no progress,
repeated denials, or expired scope.

Automatic internal file access never implies automatic replies:

| Action | Authority required |
| --- | --- |
| Use a resource inside existing authority | may be automatic |
| Obtain new authority | human approval |
| Send a cross-user message | human `Send` |

Audit every delivered snapshot with resource ID, task ID, recipient, byte
length, content hash, authorization mode, and timestamp. Never log raw file
contents.

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
- capability grants scoped to one task, one peer, and one exact resource
- authorization re-checked immediately before every file read, not cached
- resource IDs opaque to the requesting peer; canonical paths never leave the
  owning connector

The first connector transport slice uses a dedicated random bearer per local
installation. The browser's authenticated Telaegent session may issue, rotate,
or revoke it; connector routes do not accept the browser cookie or legacy app
token as a substitute. Only a SHA-256 token hash is durable. Each authenticated
poll resolves the bound user and connector instance, and a repository proof
must register the exact opaque user x repository binding before it can receive
a job. Rotation/revocation removes that principal's live relay bindings, and
stale presence cannot receive new jobs. Repository-loss events remove only the
matching user x repository binding and cancel any leased job; a short-lived,
principal-bound cancellation notice lets the owning connector stop local work
without keeping the revoked binding authorized. Connector credentials are
still validated for revocation, expiry, and account status on every request,
while safe `last_seen_at` telemetry is written at most once per 30 seconds.

## Data handling

Durable:

- users, repositories, memberships, project connections
- approved shared messages
- exact approvals and safe audit events
- safe runtime/provider status and compact conversation memory
- task IDs, opaque resource IDs and safe resource metadata, capability/grant
  metadata, and scope-decision audit events

Protected/private:

- private draft state visible only to its owner while transiting/stored by the product

Local-only:

- GitHub/provider auth and provider session state
- repositories, provider homes, and raw tool output
- canonical local filesystem paths and the resource-ID mapping

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
- that capability-scoped collaboration is implemented, tested, or enforced; it
  is a design commitment with no code behind it yet

Use controlled demo accounts and repositories until connector authentication,
local isolation, retention, revocation, and provider-policy questions are
resolved.

The current long-poll queue and binding-presence map are process-local. A cloud
restart requires the connector to replay a fresh repository proof, and there is
not yet durable redelivery across that restart. Connector packaging, signed
updates, reconnect backoff, and production operational review remain open.

## Legacy scaffold

The source tree still contains inherited ModelArk/Volcengine and fixed-workflow code for preservation and build continuity. It is not the canonical trust architecture. Standalone retired material is catalogued under `unused-code/`.

## Reporting

Report a vulnerability privately to the repository owner or event organizer with the affected revision, reproduction steps, impact, and suggested mitigation. Never put credentials, personal data, or exploit secrets in a public issue.
