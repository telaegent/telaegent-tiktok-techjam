# Contributors

Telaegent is built by a five-person team spanning backend security, local agent
runtimes, product engineering, AI evaluation, and cloud infrastructure. Our
ownership boundaries follow the project's canonical architecture: coordination
runs in the cloud, while repositories, GitHub CLI, Claude Code, Codex, and their
credentials remain on each developer's machine.

## [Anh-Khoa Dao](https://www.linkedin.com/in/anhkhoadao/)

**Backend, identity, and authorization.** Khoa co-owns the backend and leads
GitHub identity, local repository proof, project-scoped collaborator trust,
authorization and revocation, connector credentials, and deterministic
capability/file-access policy.

Khoa is a Y2 Computer Science student at the National University of Singapore
with work experience as a SWE Intern at South Telecom. He is an incoming
Software Engineer Intern at TikTok Trust and Safety.

**Stack:** TypeScript, Node.js, Fastify, Zod, PostgreSQL/Supabase, GitHub OAuth
and CLI, authorization middleware, security testing.

## [Phuong Hoang](https://www.linkedin.com/in/mark0hoang/)

**Backend and local agent runtime.** Phuong co-owns the backend and leads the
outbound local connector, Claude Code/Codex adapters, provider-session
management, durable Telaegent memory, job relay, and the bounded agentic loop.

Phuong studies Computer Science with a minor in Entrepreneurship at the
National University of Singapore and has software-engineering experience at
Autonomous Inc., as well as FDE experience at Ren Education. He also built
CommitGate, an open-source AI-assisted DevSecOps tool.

**Stack:** TypeScript, Node.js, Fastify, Claude Code CLI, Codex CLI, local
connectors, long polling, runtime/session orchestration.

## [Duy Nguyen](https://www.linkedin.com/in/zuyngn/)

**Frontend, product, and interaction design.** Duy leads Telaegent's landing and
onboarding experience, repository and collaborator flows, shared conversation,
private agent room, approval controls, and connector/status UX.

Duy is an Artificial Intelligence student at the National University of
Singapore and an AI Research Intern at Ren Education. His product-engineering
work makes the private preparation → Edit/No/Send trust model understandable
while keeping local execution boundaries visible to users.

**Stack:** React 19, TypeScript, Vite, Vitest, responsive UI engineering,
interaction design, accessible state and error UX.

## [Pham Doan Gia Hien](https://www.linkedin.com/in/pham-doan-gia-hien-00912b260/)

**Agent protocol and safety evaluation.** Hien leads Claude/Codex protocol
experiments, structured-output evaluation, adversarial and prompt-injection
testing, leakage detection, capability-policy tests, and reproducible agent
evaluation architecture.

Hien studies Computer Science at the National University of Singapore and was a
Software Engineering Intern at FPT Software. His work validates agent behavior
empirically and separates deterministic authorization guarantees from
model-dependent behavior.

**Stack:** TypeScript, Vitest, JSON schemas, Claude Code, Codex, DeepSeek,
security fixtures, protocol and regression evaluation.

## [Thai Nguyen](https://www.linkedin.com/in/thai-nguyen-38b72834b/)

**Cloud infrastructure and deployment.** Thai leads the cloud control plane,
Supabase persistence and migrations, AWS deployment, connector networking,
HTTPS, operational reliability, latency, and cost management.

Thai is a Computer Science student at the National University of Singapore and
a previous Software Engineering Intern at Nexpando, with hands-on experience
deploying Telaegent's single-origin production stack and local-to-cloud
connector path.

**Stack:** AWS EC2, Caddy, Docker, Supabase/PostgreSQL, Node.js/Fastify,
GitHub OAuth, HTTPS, deployment automation and observability.

## Shared engineering principles

- Human approval remains the boundary for every cross-user message and any new
  authority.
- Repositories and GitHub/provider credentials remain local to each developer.
- Project identity and authorization are anchored to a stable GitHub repository
  ID.
- Security-sensitive decisions are enforced by deterministic code and covered
  by tests, not delegated to an LLM.
