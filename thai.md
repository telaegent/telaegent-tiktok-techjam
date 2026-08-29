# Thai — Cloud Deployment, Runtime Isolation, Supabase, Cost, Latency, and Infrastructure

**Status:** architecture/research before full implementation  
**Product:** Telaegent

## 1. Architecture decision

Your local-connector proposal is technically attractive but is **not the canonical judged architecture** because the product direction remains browser-first/cloud-only.

Keep connector architecture as a fallback if cloud runtime isolation/authentication becomes infeasible.

Accepted infrastructure hypothesis:

```text
Vercel frontend
Azure backend/control plane
Supabase Postgres/Auth/Realtime in Singapore
Cloud isolated agent runtimes
```

## 2. Provisional deployment stack

| Layer | Technology | Location |
| --- | --- | --- |
| Frontend | React 19 + Vite | Vercel |
| Backend/control plane | Node 22 + Fastify 5 + Zod | Azure behind Caddy/HTTPS |
| Database | Supabase Postgres | Southeast Asia/Singapore |
| Telaegent auth | Supabase Auth | Supabase |
| Realtime | Supabase Realtime or simpler SSE/polling | cloud |
| Agent runtime | isolated cloud container/sandbox per user × repo | Azure |
| GitHub | `gh` inside owning runtime | cloud runtime |
| Claude/Codex | real CLI inside owning runtime | cloud runtime |

## 3. Architecture

```text
Browser
→ Vercel SPA
→ Azure Caddy/Fastify
   ├→ Supabase
   └→ Runtime Manager
       ├→ User A × Repo X runtime
       └→ User B × Repo X runtime
```

## 4. Azure sizing warning

Do not freeze a tiny burstable VM without benchmarks.

Fastify/Caddy is light. Agent execution may run:

- Claude/Codex
- Git
- package install
- builds/tests
- multiple containers

Evaluate:

### A. One demo VM

Fastest P0:

```text
Azure VM
├─ Fastify/Caddy
├─ Docker
├─ User A runtime
└─ User B runtime
```

Good for controlled hackathon; do not call it production-grade isolation.

### B. Control-plane VM + Azure Container Apps/Jobs

Cleaner separation. Azure Container Apps supports pay-per-use/scale-to-zero. Validate persistent auth/session/workspace requirements.

### C. Control-plane VM + dedicated runtime VM

Simple and predictable if Container Apps persistence is awkward.

Benchmark before choosing.

## 5. Isolation unit

Conceptual trust unit:

```text
USER × REPOSITORY
```

Require:

- separate workspace
- separate container/process boundary
- no cross-user mounts
- no sibling-repo visibility
- remote messages cannot choose host paths
- user credentials injected only to owning runtime
- bounded CPU/RAM/time/output
- no Docker socket
- log redaction
- cleanup/revocation

User-level GitHub/Claude/Codex credentials may be stored separately from repo-specific workspace/session state and injected only into that user's runtimes.

## 6. Supabase responsibilities

Store product state:

```text
users
repositories
project memberships
connections
conversations
shared messages
private-draft metadata/status
provider status
runtime bindings/status
approvals
audit events
conversation memory summaries
```

Supabase currently supports Southeast Asia/Singapore.

## 7. Secret/credential storage

Need stronger treatment than ordinary Postgres rows for:

- GitHub CLI token/auth state
- Claude auth
- Codex auth
- service secrets

Compare:

- Azure Key Vault
- encrypted volume
- protected per-user secret files
- Supabase Vault where appropriate

Do not store a shared plaintext `~/.config/gh/hosts.yml`.

## 8. Runtime persistence

Classify:

### persistent or recreatable cache
- repo checkout
- package cache
- provider session state

### sensitive persistent
- GitHub auth
- Claude auth
- Codex auth

### ephemeral
- raw CLI streams
- prompts
- temp tool output
- build artifacts
- rejected drafts

Telaegent durable memory must not depend on provider session survival.

## 9. GitHub runtime requirements

Khoa's hypothesis:

```bash
gh auth login --web --git-protocol https
gh auth status
gh auth setup-git
```

Infrastructure must answer:

- TTY/PTY?
- browser/device flow relay?
- credential location?
- behavior without keychain?
- persistence across restart?
- revocation/deletion?
- per-user mount?
- no secret logging?

## 10. Claude/Codex runtime requirements

Coordinate with Phuong:

- auth files/state
- session state
- Linux/container support
- network requirements
- filesystem requirements
- startup latency
- timeout/cancel
- auth expiry
- session resume
- credential vs repo-session separation

## 11. Latency

Measure:

### onboarding
- runtime provisioning
- GitHub auth
- provider auth
- initial clone

### warm turn
- API
- runtime acquisition
- process startup
- inference
- repo inspection
- response

### full round trip
A private draft → A send → B agent → B approval → shared response.

## 12. Cost

Produce actual current estimates after benchmark for:

### Hackathon
- Vercel
- Azure control/runtime compute
- Supabase
- storage/bandwidth

### Small beta
Major cost scales with:

```text
runtime minutes
concurrency
persistent disk
repo cache
```

The connector fallback would reduce this substantially, which is why it remains worth documenting.

## 13. Realtime

Compare:

- polling
- SSE
- Supabase Realtime
- WebSocket

Simplest reliable option wins.

## 14. Local development

Local dev may simulate cloud:

```text
localhost Vite
localhost Fastify
local/test Supabase/Postgres
Docker runtime A
Docker runtime B
```

No LAN/peer-to-peer requirement.

## 15. Failure/recovery

Define:

- backend restart
- runtime crash
- VM reboot
- GitHub revoked
- provider auth expired
- repo corrupt
- provider session lost
- Supabase unavailable
- runtime queue congestion
- repo disconnect
- account deletion

Failed private runtime must never create a shared message.

## 16. Security claims

Do not claim:

- repo contents never reach Telaegent cloud
- provider credentials never reach Telaegent cloud
- zero knowledge
- E2E encryption
- production multi-tenancy

Those belonged to the connector alternative, not cloud-only architecture.

## 17. Deliverables

- architecture diagram
- exact Azure P0 recommendation
- VM/runtime benchmark
- isolation design
- Supabase responsibility matrix
- secret-storage recommendation
- latency numbers
- hackathon cost
- small-beta cost
- deployment checklist
- recovery design
- fallback connector architecture in separate notes

## 18. Do not do

- no canonical local connector
- no shared unrestricted `$HOME`
- no ordinary DB storage for provider/GitHub secrets
- no unbenchmarked tiny VM freeze
- no Kubernetes unless absolutely necessary
- no fake "repos stay local" claim
- no overbuilt realtime stack

