# Thai — Cloud Deployment, Runtime Isolation, Database, Storage, Cost, and Latency Research

**Status:** Research/design brief before implementation  
**Product:** Telaegent  
**Primary goal:** Decide the smallest cloud architecture that can reliably run the complete hackathon product without creating dangerous cross-user state or an unaffordable/slow demo.

---

# 1. Product context

Telaegent is now **cloud-only**.

There is no required local worker or private LAN.

A user should be able to:

```text
Open Telaegent website
        ↓
Sign in
        ↓
Connect GitHub
        ↓
Connect Claude Code / Codex
        ↓
Choose repository
        ↓
Talk to collaborator's agent
```

The cloud must therefore support:

- frontend
- backend API
- database
- GitHub integration
- shared project conversations
- private per-user agent conversations
- repository checkout/workspace
- Claude Code CLI
- Codex CLI
- persistent provider authentication/session state where required
- isolated execution
- logs/audit
- safe secrets

Your job is to determine where and how these pieces should run.

Do **not** implement yet.

---

# 2. Main questions

You must give the team concrete recommendations for:

1. Where should the frontend be hosted?
2. Where should the backend be hosted?
3. Which database should we use?
4. Do we need object storage?
5. How do we run Claude Code/Codex CLI in the cloud?
6. What is the isolation unit?
7. What needs persistent disk?
8. What should be ephemeral?
9. Where do GitHub/provider credentials live?
10. What is the expected cold-start latency?
11. What is normal message latency?
12. What will the demo cost?
13. What would a small real beta cost?
14. What happens when a runtime crashes?
15. How do we prevent User A from seeing User B's repository/auth/session files?

---

# 3. Architecture candidates to compare

Do not jump directly to one vendor because it is familiar.

Compare at least 2–3 viable patterns.

## Candidate A — Serverless web/backend + container runtime service

Concept:

```text
Frontend: Vercel/Cloudflare/etc.
Backend API: serverless or small persistent service
Database: managed DB
Agent execution: isolated container jobs/service
Persistent auth/session volume: dedicated secure storage
```

Pros:

- easy web deployment
- scalable API
- agent execution separated

Questions:

- can provider CLI auth state persist cleanly?
- container startup latency?
- cost per always-on vs per-job runtime?

## Candidate B — One application platform with persistent worker containers

Examples might include Railway/Fly/Render/etc., but research current options.

Concept:

```text
Frontend
Backend
DB
Runtime manager
persistent volumes
```

Pros:

- simple hackathon setup

Risks:

- isolation may be weaker if badly designed
- per-user runtime lifecycle can get awkward

## Candidate C — VM/container host with our own runtime manager

Concept:

```text
one cloud VM / cluster
backend
database or managed DB
Docker containers per user × repo
persistent per-runtime volume
```

Pros:

- maximal control
- predictable CLI behavior

Risks:

- ops burden
- security burden
- harder scaling
- dangerous if containers are not genuinely isolated

For the hackathon, simplicity may beat theoretical elegance.

---

# 4. Runtime isolation is the most important part of your work

A fresh shell is **not** isolation.

The target mental model is:

```text
User A × Repo X runtime
┌────────────────────────────┐
│ Repo X checkout            │
│ A's GitHub access          │
│ A's Claude/Codex auth      │
│ A's provider sessions      │
│ A's private working state  │
└────────────────────────────┘

User B × Repo X runtime
┌────────────────────────────┐
│ separate repo checkout     │
│ B's credentials            │
│ B's provider state         │
│ no visibility into A       │
└────────────────────────────┘
```

Research whether the hackathon should isolate:

### Option 1 — per user

```text
one runtime per Telaegent user
```

Easy but Repo A and Repo B share a user environment.

### Option 2 — per user × repository

```text
one runtime per user per connected repo
```

Stronger project isolation and easier mental model.

Likely preferred, but test the cost/complexity.

### Option 3 — ephemeral execution + persistent encrypted state

Each call launches an isolated job and mounts only the user's repo plus minimal provider state.

Potentially safer but may create cold-start overhead.

Your recommendation must discuss:

- filesystem
- `$HOME`
- Git credentials
- Claude state
- Codex state
- repo checkout
- provider session IDs/files
- temp files
- process isolation
- environment variables
- network access
- cleanup

---

# 5. Persistence design

Classify every important category into:

```text
database
persistent runtime volume
object storage
ephemeral memory/disk
NEVER STORE
```

At minimum classify:

## Product/business state

- users
- GitHub identity metadata
- repositories
- project memberships
- collaborator connections
- shared conversations
- shared messages
- private draft metadata
- explicit send approvals
- provider connection status
- audit events

## Agent/runtime state

- Claude/Codex auth state
- provider session state
- CLI home directory
- repo checkout
- working tree modifications
- cached dependencies
- private agent transcript
- compacted Telaegent memory
- temporary outputs
- logs

## Secrets

- GitHub access tokens
- provider credentials
- internal service keys
- raw `.env` from repositories
- copied secret-bearing output

The answer must not be "put everything in the database."

---

# 6. Database research

Compare realistic hackathon-friendly options.

Evaluate:

- Postgres
- managed Postgres providers
- SQLite only if you can justify concurrency/deployment
- document DB only if there is a real advantage
- hosted BaaS such as Supabase if useful

Important criteria:

- setup speed
- auth integration
- migrations
- relational queries for users/repos/connections/conversations
- transactional integrity
- cost
- observability
- easy local development
- deployment simplicity

My current bias is that the logical model is relational:

```text
users
repositories
repository_memberships
connections
conversations
messages
drafts
runtime_bindings
audit_events
```

but your job is to research, not rubber-stamp that bias.

---

# 7. Frontend hosting

Duy owns the frontend itself. You own deployment.

Answer:

- Vercel?
- Cloudflare Pages?
- same server as backend?
- another choice?

Evaluate:

- deploy speed
- custom domain
- environment variables
- WebSocket/SSE support if later needed
- same-origin/API setup
- preview deployments
- cost

Do not overbuild.

---

# 8. Backend hosting

Phuong + Khoa own backend logic.

You need to recommend the environment.

Questions:

- always-on Node/Fastify server vs serverless functions?
- does long-running CLI orchestration make serverless awkward?
- should the API only enqueue runtime jobs?
- do we need a background worker service?
- can we avoid a dedicated message broker for the hackathon?
- how does the backend learn that a CLI run finished?
- what is the cleanest live-update mechanism: polling, SSE, WebSocket?

Do not optimize for millions of users. Optimize for a flawless demo and a credible path forward.

---

# 9. Provider CLI execution

Research the practical implications of hosting the actual CLIs.

For Claude Code and Codex separately determine:

- installation method
- minimum runtime dependencies
- whether they run cleanly in Linux containers
- where auth state is stored
- where session state is stored
- whether `$HOME` must persist
- how to safely launch a new process per turn
- how resume behaves after process exit
- whether provider auth expires
- process timeout
- resource requirements
- possible outbound network requirements
- any vendor-policy concern with hosted multi-user use

Coordinate with Phuong. Thai owns infra mechanics; Phuong owns CLI semantics.

---

# 10. Latency budget

Build a realistic latency model.

Example stages:

```text
browser -> backend           50–300ms?
runtime acquisition          0–5s?
repo readiness               0–?
CLI startup                  0.2–2s?
LLM inference                3–30s+
tool/repo inspection         variable
backend -> UI update         <1s
```

Measure rather than guess where possible.

For the demo, answer:

- first-ever runtime cold start
- warm runtime message
- repository clone
- repository refresh/pull
- Claude/Codex simple response
- agent reading a few files
- full cross-user round trip

Then tell the team which actions need:

```text
spinner
streaming
progress state
prepared warm runtime
pre-cloned repo
```

---

# 11. Cost model

Give at least two cost views.

## 11.1 Hackathon/demo

Assume:

- five developers
- two demo users
- one or a few repos
- low traffic
- several hundred agent calls maximum

Estimate:

- frontend
- backend
- DB
- container/VM compute
- persistent disks
- bandwidth
- logs/storage
- provider subscription/API implications if any

## 11.2 Small beta

Example:

- 100 active users
- 20 concurrent users
- 5–20 agent turns/user/day
- several connected repos

Do not fake precision. Give assumptions and ranges.

Highlight which cost scales with:

```text
users
persistent environments
runtime minutes
storage
provider usage
```

---

# 12. Security / credential handling

You need to propose the minimum responsible design for:

- GitHub tokens
- Claude/Codex auth material
- Telaegent service secrets
- database credentials
- encryption at rest where available
- secret injection into runtimes
- log redaction
- deleting/revoking a provider connection
- deleting/revoking a repository
- container compromise blast radius

For the hackathon, we can be honest about limitations.

Do not make unsupported claims such as:

```text
"military-grade isolation"
"zero knowledge"
"we cannot see user data"
```

unless actually true.

---

# 13. Failure modes

Design behavior for:

- runtime unavailable
- container crash
- backend redeploy during agent run
- DB unavailable
- provider auth expired
- GitHub token revoked
- repo deleted
- branch disappeared
- user disconnects repo
- two messages arrive simultaneously
- one user has both Claude and Codex
- provider session resume fails
- runtime volume corrupts
- idle runtime evicted
- cold start takes too long

For each say whether we:

```text
retry
recreate
ask user to reconnect
fall back to Telaegent memory
show error
```

---

# 14. Data retention recommendation

For each data class propose retention:

```text
shared project messages       durable until user/project deletion
private drafts                short-lived?
provider sessions             runtime-managed
raw CLI output                don't persist / short-lived
audit events                  durable
repo checkout                 cached/recreatable
credentials                   until revoked, protected
secret-bearing blocked data   never persist
```

Coordinate with Phuong/Khoa because backend behavior depends on this.

---

# 15. Deliverables

Produce:

### A. One-page recommended cloud architecture

Diagram + service choices.

### B. Vendor decision table

For each chosen component:

```text
choice
alternative
why chosen
estimated cost
known limitation
```

### C. Runtime isolation decision

Precisely define the isolation unit and persistent state.

### D. Storage/data matrix

Database vs persistent volume vs ephemeral vs never store.

### E. Cost estimate

Hackathon and small beta.

### F. Latency measurements

Run real tests where possible.

### G. Failure/recovery plan

Especially provider auth/session loss.

### H. Deployment checklist

Exact environments and secrets required, but do not include real secret values.

---

# 16. Definition of done

You are done when the team can answer:

> “Where does every component run, where does every important piece of data live, how is User A isolated from User B, what happens after a restart, what does one live demo cost, and where will latency come from?”

without hand-waving.

---

# 17. Do not do yet

- Do not lock into Kubernetes.
- Do not add Kafka/Redis/RabbitMQ without a proven need.
- Do not build autoscaling before the happy path.
- Do not let two users share one unrestricted CLI home/workspace.
- Do not assume a new shell means a fresh identity/session.
- Do not put raw provider credentials in ordinary DB rows or logs.
- Do not persist every CLI transcript by default.
- Do not optimize cloud cost at the expense of demo reliability.
- Do not code the frontend/backend product logic; Duy and Phuong/Khoa own those.
