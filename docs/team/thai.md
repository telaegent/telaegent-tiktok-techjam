# Thai — Cloud Deployment, Connector Networking, Supabase, Cost, Latency, and Infrastructure

**Status:** architecture/research before full implementation  
**Product:** Telaegent

## 1. Architecture decision

The local connector is the **canonical judged architecture**. Browser-first
describes the product UI and coordination plane; it does not move repositories
or provider CLIs into the cloud.

Accepted infrastructure hypothesis:

```text
Vercel frontend
AWS EC2 backend/control plane
Supabase Postgres/Auth/Realtime in Singapore
Outbound local connectors
```

## 2. Provisional deployment stack

| Layer | Technology | Location |
| --- | --- | --- |
| Frontend | React 19 + Vite | Vercel |
| Backend/control plane | Node 22 + Fastify 5 + Zod | AWS EC2 behind Caddy/HTTPS |
| Database | Supabase Postgres | Southeast Asia/Singapore |
| Telaegent identity persistence | GitHub OAuth account + hashed Telaegent sessions | Supabase Postgres |
| Realtime | Supabase Realtime or simpler SSE/polling | cloud |
| Connector relay/presence | bounded jobs over WebSocket/long-poll | AWS EC2 |
| Agent execution | connector binding per user × repo | local developer machine |
| GitHub | developer's existing `gh` | local developer machine |
| Claude/Codex | developer's authenticated real CLI | local developer machine |

## 3. Architecture

```text
Browser
→ Vercel SPA
→ AWS EC2 Caddy/Fastify
   ├→ Supabase
   └→ Connector presence/job relay
       ├↔ User A × Repo X local connector
       └↔ User B × Repo X local connector
```

## 4. Sizing warning

The EC2 control plane runs the API, connector presence/job relay, approvals, and
product data integration—not Git, provider CLIs, builds, tests, or repository containers.
Benchmark concurrent long-lived outbound connections, job envelopes, realtime
fan-out, API traffic, and database latency before choosing an instance size.

## 5. Isolation unit

Conceptual trust unit:

```text
USER × REPOSITORY
```

Require across the cloud/local seam:

- one opaque cloud binding per user × repository
- local binding-to-workspace mapping never uploaded
- no sibling-repo resolution
- remote/cloud messages cannot choose local paths, executables, or commands
- GitHub/provider credentials remain local and are never injected by cloud
- bounded CPU/RAM/time/output
- no Docker socket
- log redaction
- cleanup/revocation

The connector may reuse a developer's local provider authentication while
keeping provider sessions and workspace scope project-specific. The cloud sees
only safe provider availability.

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
connector bindings/presence/status
approvals
audit events
conversation memory summaries
```

Supabase currently supports Southeast Asia/Singapore.

## 7. Secret/credential storage

GitHub CLI, Claude, and Codex credentials remain local and must never appear in
Postgres, a managed secret store, connector job payloads, frontend storage, or
logs. AWS Secrets Manager (or SSM Parameter Store) remains appropriate for
Telaegent service secrets and connector signing/verification keys only.

## 8. Runtime persistence

Classify:

### local persistent or recreatable state
- repo checkout/worktree and package cache
- GitHub/provider auth
- provider session state
- binding-to-workspace/provider mapping

### ephemeral
- raw CLI streams
- prompts
- temp tool output
- build artifacts
- rejected drafts

Telaegent durable memory must not depend on provider session survival.

## 9. Local GitHub connector requirements

Khoa's local checks:

```bash
gh auth status
git remote get-url origin
git rev-parse HEAD
```

Infrastructure must answer:

- how the connector authenticates to cloud and rotates its credential;
- how presence/reconnect and job redelivery work;
- how local proof expires and is revalidated;
- how revocation reaches an offline connector;
- how no credential, local path, or secret reaches logs/payloads.

## 10. Claude/Codex runtime requirements

Coordinate with Phuong:

- local auth files/state (never uploaded)
- local session state
- Windows/macOS/Linux support
- network requirements
- filesystem requirements
- startup latency
- timeout/cancel
- auth expiry
- session resume
- local credential vs repo-session separation

## 11. Latency

Measure:

### onboarding
- connector install/start
- connector authentication and repository registration
- local GitHub/provider probes

### warm turn
- API
- connector delivery/acknowledgement
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
- AWS EC2 control-plane/relay compute
- Supabase
- storage/bandwidth

### Small beta
Major cost scales with:

```text
connected connector/job relay traffic
concurrency
realtime/database usage
```

Local execution keeps provider compute, repository storage, and build/test cost
off Telaegent cloud; include connector bandwidth and support cost.

## 13. Realtime

Compare:

- polling
- SSE
- Supabase Realtime
- WebSocket

Simplest reliable option wins.

## 14. Local development

Local development uses the same split:

```text
localhost Vite
localhost Fastify
local/test Supabase/Postgres
local connector A
local connector B
```

Connectors talk outbound to localhost just as they talk outbound to production.
No LAN/peer-to-peer or inbound-port requirement.

## 15. Failure/recovery

Define:

- backend restart
- connector/local provider crash
- VM reboot
- GitHub revoked
- provider auth expired
- local repo unavailable
- provider session lost
- Supabase unavailable
- connector offline or job queue congestion
- repo disconnect
- account deletion

Failed private runtime must never create a shared message.

## 16. Security claims

Do not claim zero knowledge, E2E encryption, perfect local sandboxing, or
execution while the connector is offline. Do state the enforced architecture:
repository checkouts and GitHub/provider credentials are local-only and must
not be uploaded to Telaegent cloud.

## 17. Deliverables

- architecture diagram
- exact EC2 control-plane/relay P0 recommendation
- connector transport and concurrency benchmark
- connector authentication, presence, reconnect, and job delivery design
- local binding/isolation requirements
- Supabase responsibility matrix
- secret-storage recommendation
- latency numbers
- hackathon cost
- small-beta cost
- deployment checklist
- recovery design
- connector install/update/revocation checklist

## 18. Do not do

- no cloud-hosted provider/GitHub CLI or repository clone
- no cloud database/storage for provider/GitHub secrets or local paths
- no arbitrary command/path in connector jobs
- no unbenchmarked tiny VM freeze
- no Kubernetes unless absolutely necessary
- no claim that the connector works while the developer machine is offline
- no overbuilt realtime stack
