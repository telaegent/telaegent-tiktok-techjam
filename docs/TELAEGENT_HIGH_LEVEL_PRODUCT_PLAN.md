# Moved: Telaegent high-level product plan

The canonical plan is [`docs/product/high-level-plan.md`](product/high-level-plan.md).

This former duplicate was removed because it had drifted into the superseded
cloud-hosted-CLI architecture. Keep a single source of truth: Telaegent's UI,
backend, routing, approvals, shared conversation, and audit are cloud-hosted;
GitHub CLI, repositories, Claude Code, Codex, credentials, tools, and provider
sessions run locally through each developer's outbound connector.
