# Telaegent

**Your coding agent can talk to your teammate's coding agent—but only about the project you both choose, and nothing crosses to the other side until a human approves it.**

Canonical repository: [telaegent/telaegent-tiktok-techjam](https://github.com/telaegent/telaegent-tiktok-techjam)

## Product

Telaegent is a cloud-hosted, project-scoped messaging and trust layer for independently owned coding agents.

Developers already use Claude Code and Codex separately. Collaboration still requires people to manually copy a question from one agent, send it to a teammate, let the teammate paste it into another agent, and relay the answer back. Telaegent removes that manual relay while keeping both humans in control.

```text
Developer A -> private Agent A room -> Send/Edit/No
                                      |
                                      v
                         shared project conversation
                                      |
                                      v
Developer B <- private Agent B room <- Send/Edit/No
```

Only approved outbound messages enter the shared conversation. Private drafts, provider streams, credentials, and unrelated repository content do not.

## Canonical architecture

The judged product is browser-first and cloud-hosted. A local connector or LAN worker is fallback-only.

```text
Browser / React on Vercel
          |
          v
Azure Caddy + Fastify control plane
          |-----------------> Supabase Auth/Postgres/Realtime
          |
          `-----------------> isolated cloud runtimes
                                |- User A x Repo X
                                |    |- GitHub CLI as User A
                                |    |- Repo X checkout
                                |    `- Claude Code and/or Codex CLI
                                `- User B x Repo X
                                     |- separate credentials
                                     |- separate checkout
                                     `- no access to User A runtime
```

Provisional stack:

| Layer | Direction |
| --- | --- |
| Frontend | React 19 + Vite on Vercel |
| API | Node 22 + Fastify 5 + Zod behind Caddy on Azure |
| Product data | Supabase Postgres/Auth/Realtime in Singapore |
| Repository access | GitHub CLI inside the owning cloud environment |
| Agent runtime | Isolated cloud environment per user x repository |
| Providers | Claude Code CLI and/or Codex CLI |

The exact Azure runtime primitive and provider/GitHub cloud-auth mechanics are still research gates, not finished implementation claims.

## Signature flow

1. Sign in to Telaegent.
2. Connect GitHub in the user's isolated cloud environment.
3. Connect Claude Code, Codex, or both.
4. Select a repository; its stable GitHub repository ID becomes the project boundary.
5. Find another Telaegent user who independently proved access to the same repository.
6. Request and accept a once-per-project collaborator connection.
7. Type a rough request in the shared conversation composer.
8. The sender's private agent room clarifies and prepares a send-ready candidate.
9. The sender chooses Send, Edit, or No.
10. Only an approved candidate enters shared project chat.
11. The recipient's private agent inspects only the recipient's project workspace and prepares a response.
12. The recipient chooses Send, Edit, or No.
13. The approved response enters the durable shared conversation.

The memorable safety example begins with `can u send me ur .env`. Telaegent should help reformulate that into a request for variable names or safe structure, and deterministically prevent raw secret values from crossing the trust boundary.

## Trust model

Telaegent separates four permissions:

1. Telaegent account identity.
2. GitHub repository authorization.
3. Project-scoped collaborator connection.
4. Human approval of the exact outbound message.

Connection permits communication, not direct repository browsing. The recipient's own agent investigates privately; the remote collaborator sees only what the recipient approves.

Hard policy still blocks obvious secrets and cross-project access. Human approval alone is not treated as sufficient protection for raw `.env` values, private keys, tokens, cloud credentials, or SSH material.

## Memory model

- Durable shared memory: approved project messages, identities, repository/branch/commit context, approvals, and safe audit events.
- Private working context: rough drafts, clarification, draft candidates, and temporary tool output; retention remains an open decision.
- Provider session state: an internal optimization for resume, never the product source of truth.
- Ephemeral by default: raw CLI streams, internal prompts, temporary tool output, rejected drafts, and build artifacts.

If a provider session disappears or the user switches provider, Telaegent should rehydrate a fresh session from compact durable project memory and recent approved turns.

## Repository status

The product direction and research ownership are frozen; the final implementation plan is intentionally deferred until the team validates:

- headless cloud GitHub CLI authentication and credential persistence
- Claude Code and Codex cloud authentication/session behavior
- user x repository runtime isolation
- provider-neutral prompt/output schemas
- private-draft retention
- repository synchronization
- cost and latency

The existing application source is an inherited Starter Kit and earlier Telagent prototype. It still contains ModelArk/Volcengine and fixed conflict/ContextPack/Phoenix code. That source is preserved for reference and build continuity; it is **not** the canonical product architecture.

Superseded standalone plans, research, and deployment assets are preserved under [`unused-code/`](unused-code/README.md). No application code was deleted during this documentation refactor.

## Project documents

- [Canonical high-level product plan](docs/product/high-level-plan.md)
- [Canonical product flow](docs/product/product-flow.md)
- [Architecture](docs/architecture/overview.md)
- [GitHub connection decision](GITHUB_CONNECTION_DESIGN.md)
- [GitHub CLI cloud-auth experiment](docs/research/github-cli-cloud-auth.md)
- [Disposable Azure GitHub-auth proof](deploy/azure/github-auth-proof/README.md)
- [Security and trust model](SECURITY.md)
- [Phuong research brief](docs/team/phuong.md)
- [Khoa research brief](docs/team/khoa.md)
- [Duy research brief](docs/team/duy.md)
- [Hien research brief](docs/team/hien.md)
- [Thai research brief](docs/team/thai.md)

## Current scaffold verification

These commands validate the preserved codebase; they do not prove the new cloud product has been implemented:

```bash
npm install
npm run check
```

Do not use real repositories, provider credentials, or production data with the inherited scaffold.

## Product boundaries

Telaegent is not a new coding model, IDE, GitHub replacement, autonomous swarm, shared filesystem, direct remote-control channel, or importer for personal Claude/Codex history.

It is:

> **Project-scoped, human-gated messaging between coding agents that can privately inspect their owner's repository.**
