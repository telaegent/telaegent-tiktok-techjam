# Telaegent

**Project-scoped, human-gated messaging between separately owned coding agents.**

> Your agent can talk to my agent — but only about the project we both chose, and nothing crosses until a human approves it.

Two developers each connect their own GitHub repository and their own coding agent (Claude Code or Codex). When one wants something from the other, their own agent privately helps them prepare the request; they approve it; it enters a shared project conversation; the recipient's agent privately investigates their own repository; the recipient approves the answer. Neither side ever gets a filesystem handle into the other's workspace.

TikTok TechJam prototype, built on the Agent Launchpad Starter Kit.

## Status

**Research phase.** `docs/plan/TELAEGENT_HIGH_LEVEL_PRODUCT_PLAN.md` freezes the product direction; the implementation is deliberately deferred until the five research briefs in `docs/plan/` report back.

What exists today is the Starter Kit control plane (Agent CRUD, Playground, Codex and Claude Code adapters, isolated workspaces, JSON persistence) plus the landing page. The new backend is not built yet.

## Layout

| Path | What |
| --- | --- |
| `apps/server` | Fastify control plane, `AgentService`/`AgentRunner`, provider adapters, `JsonStore` |
| `apps/web` | Starter Kit Playground |
| `apps/landing` | Marketing landing page |
| `tests/agent-protocol` | Agent protocol evaluation harness (scaffold) |
| `docs/plan` | Canonical product plan and the five research briefs |
| `docs/archive/v1` | Superseded v1 planning documents |
| `legacy` | Archived v1 code — unwired, excluded from build and CI |

## Running it

Requires Node.js 22+ and npm 10+.

```bash
npm install
```

Server and Playground together:

```bash
npm run dev
```

Landing page on its own:

```bash
npm run dev -w @telaegent/landing
```

Full gate — typecheck, test, build:

```bash
npm run check
```

The server reads configuration from `.env`; copy `.env.example` and fill it in. The Playground needs `ARK_API_KEY` and `ARK_MODEL` to run agents. Note that BytePlus ModelArk is Starter Kit heritage — the new product runs the Claude Code and Codex CLIs directly, so this dependency is expected to fall away.

## The trust model

Three permission boundaries, each independent:

1. **Repository access** — which repositories the user deliberately connected to Telaegent.
2. **Project relationship** — who may communicate with them about that repository, accepted once and revocable.
3. **Outbound information** — what they are actually willing to send right now, approved per message.

Underneath all three, deterministic policy refuses obvious secrets — `.env*`, private keys, tokens, cloud and SSH credentials, anything outside the project boundary — even when a human approves them. Human approval is not the only safety mechanism.

## Honest limitations

- Cloud hosting makes Telaegent the custodian of repository copies and provider credentials. The hackathon uses controlled demo accounts; production would need hardened multi-tenant isolation.
- "Private" means private from the collaborator, not from the Telaegent operator. There is no end-to-end encryption.
- Running per-user Claude Code/Codex CLI environments as a hosted product needs provider terms review before it is a real product.

## Archived v1

An earlier direction encoded one fixed workflow — publish intent, detect conflict, exchange status, propose resolution, dual approval, ContextPack, dependency change, replan — as the whole product. It is superseded by the smaller messaging primitive, and conflict negotiation can return later as one use case built on top.

That code is archived under `legacy/`, not deleted: its path-authorization policy, redaction, git helpers and test harness are directly reusable. `legacy/README.md` records what is worth harvesting and three known bugs that went with it.

## License

See `LICENSE`.
