import { describe, expect, it } from "vitest";
import type {
  CapabilityScopeRequest,
  ConversationMessage,
  PrivateDraftView,
  ProjectSummary,
  TelaegentSession,
} from "./api";
import { isUiPreviewEnabled, previewRequest } from "./preview-api";

describe("local UI preview", () => {
  it("is explicit and query-gated", () => {
    expect(isUiPreviewEnabled("?view=platform")).toBe(false);
    expect(isUiPreviewEnabled("?view=platform&preview=1")).toBe(true);
  });

  it("opens an authenticated project and exercises the approval and send UI paths", async () => {
    const session = await previewRequest("/api/auth/session") as TelaegentSession;
    expect(session).toMatchObject({
      enabled: true,
      authenticated: true,
      user: { githubLogin: "duy-preview" },
    });

    const projects = await previewRequest("/api/projects?limit=50") as {
      projects: ProjectSummary[];
    };
    expect(projects.projects).toHaveLength(1);

    const collaborators = await previewRequest(
      "/api/projects/33333333-3333-4333-8333-333333333333/collaborators?limit=50",
    ) as { collaborators: unknown[] };
    expect(collaborators.collaborators).toHaveLength(1);

    const pending = await previewRequest(
      "/api/capability/scope-requests?githubRepositoryId=987654321",
    ) as { requests: CapabilityScopeRequest[] };
    expect(pending.requests).toHaveLength(1);
    await previewRequest(
      `/api/capability/scope-requests/${pending.requests[0]!.scopeRequestId}/decision`,
      { method: "POST", body: JSON.stringify({ decision: "once" }) },
    );
    const decided = await previewRequest(
      "/api/capability/scope-requests?githubRepositoryId=987654321",
    ) as { requests: CapabilityScopeRequest[] };
    expect(decided.requests).toEqual([]);

    const created = await previewRequest(
      "/api/conversations/44444444-4444-4444-8444-444444444444/drafts",
      {
        method: "POST",
        body: JSON.stringify({ provider: "claude", roughMessage: "Check the refresh flow" }),
      },
    ) as { draft: PrivateDraftView };
    expect(created.draft.state).toBe("created");

    const started = await previewRequest(`/api/drafts/${created.draft.draftId}/run`, {
      method: "POST",
      body: "{}",
    }) as { draft: PrivateDraftView };
    expect(started.draft.state).toBe("agent_working");

    const settled = await previewRequest(`/api/drafts/${created.draft.draftId}`) as {
      draft: PrivateDraftView;
    };
    expect(settled.draft).toMatchObject({ state: "ready" });
    expect(settled.draft.sendCandidate).toContain("session guard");

    const sent = await previewRequest(`/api/drafts/${created.draft.draftId}/send`, {
      method: "POST",
      body: JSON.stringify({
        approvedContent: settled.draft.sendCandidate,
        idempotencyKey: "preview-test-send",
      }),
    }) as { message: ConversationMessage };
    expect(sent.message.body).toBe(settled.draft.sendCandidate);

    const conversation = await previewRequest(
      "/api/conversations/44444444-4444-4444-8444-444444444444/messages?githubRepositoryId=987654321",
    ) as { messages: ConversationMessage[] };
    expect(conversation.messages.at(-1)?.messageId).toBe(sent.message.messageId);
  });
});
