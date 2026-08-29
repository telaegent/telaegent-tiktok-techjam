# CLAUDE.md

## Project

Telaegent is coordination and trust middleware for separately owned coding agents. The TikTok TechJam prototype extends the Agent Launchpad Starter Kit with one Phoenix demo project, two mock owners, and two isolated coding-agent workspaces. Its canonical flow is: publish intent → detect conflict → exchange structured status → propose a resolution → obtain separate human approvals → transfer a permissioned, source-backed ContextPack → detect a dependency change → adapt the affected plan → complete with an auditable history.

## Stack (locked)

- TypeScript on Node.js 22+ and npm 10+
- React 19 and Vite; no router or frontend state library
- Fastify 5 and Zod
- Existing atomic JSON store; no new database, queue, or vector store
- Existing `AgentService`/`AgentRunner` boundary with Codex CLI and an optional, honestly reported Claude Code CLI adapter
- Vitest, Fastify injection, fake runners, and `npm run check`
- Local macOS/Linux/WSL2 demo path; cloud work is post-freeze only

Do not add LangChain, a multi-agent framework, Prisma, React Router, Redux, Tailwind, a component library, a message broker, or a new cloud service during the hackathon.

## Workstream ownership

| Owner | Area |
| --- | --- |
| Phuong | Runtime providers, `AgentService` execution seam, provider lifecycle/security |
| Khoa | Backend orchestration, persistence, Operations, routes, shared memory, integration |
| Duy | Protocol/types/Zod schemas, permissions, states, conflict/agreement rules |
| Thai | Landing, product shell, conversation cards, polling, demo UX |
| Hien | Tool execution, ContextPack security, Phoenix/Git fixture, dependency and E2E tests |

Stay within the current owner's files unless that owner explicitly hands work over. Do not let multiple agents edit `types.ts`, `store.ts`, `App.tsx`, or `agent-service.ts` concurrently.

## Hard constraints

1. Extend the Starter Kit; preserve its Agent CRUD, Playground, Fastify control plane, `AgentService`, `AgentRunner`, persistent sessions, isolated workspaces, Runtime containers, and JSON persistence.
2. `TelaegentService` invokes providers only through `AgentService`; no route or tool calls a runner directly. `AgentService` remains the sole owner of busy locks, lifecycle, cancellation, and session updates.
3. A run receives exactly one validated workspace. Never let two agents write the same working directory, mount both workspaces together, or merge/push branches automatically.
4. Treat model output, repository content, paths, and tool arguments as untrusted. Zod schemas and deterministic policy checks must precede state changes or disclosure.
5. The model may propose; deterministic code authorizes and humans approve. A model cannot grant permission, approve an agreement, or weaken a path rule.
6. Never persist or expose raw runtime prompts, unvalidated output, complete provider transcripts/JSONL, hidden reasoning, private conversations, denied contents, credentials, environment values, provider homes, or session IDs.
7. Reject forbidden paths before reading: absolute/traversal paths, `.env*`, `.git/**`, secret/credential/token/key paths, external symlinks, and anything outside the canonical workspace.
8. Planning, status, proposal, ContextPack, dependency, and replan runs are read-only. Only `implement` may use workspace-write, and ContextPack runs are fresh/ephemeral with no network.
9. Do not silently fall back between providers or claim a fake/fixture run is live. Describe the design as A2A-inspired, not A2A-compliant, and state local encryption/auth limitations honestly.
10. Keep loops bounded to three internal steps and three inter-agent exchanges. Preserve idempotency, TTL, version-pinned decisions, safe errors, and append-only audit evidence.
11. Never reduce Telaegent to a lock manager, task queue, generic chat, or direct agent-to-agent transcript exchange. Preserve the entire canonical flow.
12. Keep P0 narrow: two agents, two owners, one Phoenix project, one conflict, one dual approval, one valid pack, one forbidden request, one dependency change, and one adaptive replan.

## Response discipline

- Lead with the outcome and one recommended path.
- Inspect actual code before proposing or editing.
- State assumptions and cross-owner contract needs explicitly.
- Report exact files changed, verification evidence, and unresolved integration needs.
- Never call work complete when verification is missing or failing.

## Definition of done

Work is `done` only when the requested behavior is demonstrated, focused tests pass, `npm run check` passes, normal Playground behavior remains intact, sensitive data is absent from persistence/UI, no task-related TODO/FIXME remains, and any affected harness topic doc is current. If any condition fails, report `in_progress` and the exact blocker.

The submission is complete only when the full Phoenix flow works, at least one genuine provider run is shown, `.env` denial occurs live before access, the audit trail is complete, and a fresh setup plus `npm run poc` succeeds on the supported demo environment.

## Session protocol

- Start: read `my-harness/session-log.md`, check `my-harness/observations.md`, load matching topic docs, and declare `Session scope: ...`.
- During: append `[NN] <decision and why>` immediately for non-obvious decisions or changed approaches.
- End: refresh Current Verified State, append a Session Record with evidence/risks/next action, update affected topic docs, clear observations, and remind Phuong to commit; never auto-commit unless asked.
- Do not write outside the declared scope without stating the scope change.

## Topic docs (load only when the condition matches)

| File | Load when… |
| --- | --- |
| `my-harness/session-log.md` | Always, first at session start |
| `my-harness/runtime-providers.md` | Touching runners, `AgentService`, runtime config, capability detection, sandbox/session behavior, cancellation, or provider errors |
