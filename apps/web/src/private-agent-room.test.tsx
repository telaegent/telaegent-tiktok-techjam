import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PrivateDraftView } from "./api";
import { PrivateAgentRoom } from "./ProductApp";

const draft: PrivateDraftView = {
  draftId: "draft-1",
  conversationId: "conversation-1",
  githubRepositoryId: "123",
  provider: "codex",
  role: "sender",
  roughMessage: "Check the session guard.",
  incomingMessageId: null,
  privateTurns: [],
  state: "ready",
  turnId: "turn-1",
  privateMessage: "I checked the repository and prepared a response.",
  sendCandidate: "The session guard rejects refresh-token reuse.",
  riskFlags: [],
  guardFindings: [],
  failure: null,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:02.000Z",
  sentMessageId: null,
};

function renderRoom(responseReveal: {
  draftId: string;
  responseVersion: string;
  firstNewTurnIndex: number;
} | null) {
  return renderToStaticMarkup(
    <PrivateAgentRoom
      open
      draft={draft}
      answering={null}
      recipient={{
        id: "peer-1",
        githubLogin: "peer",
        name: "Peer",
        avatarUrl: null,
        topic: "Session guard",
        provider: "Claude Code",
        branch: "main",
        status: "connected",
      }}
      runtimeModels={null}
      selectedModel=""
      selectedEffort={null}
      runtimeModelsState="ready"
      clarification=""
      approvedContent={draft.sendCandidate ?? ""}
      editingCandidate={false}
      busy={false}
      error={null}
      responseReveal={responseReveal}
      onClarificationChange={vi.fn()}
      onApprovedContentChange={vi.fn()}
      onClarify={vi.fn()}
      onNo={vi.fn()}
      onEdit={vi.fn()}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onRetryRuntimeModels={vi.fn()}
    />,
  );
}

describe("PrivateAgentRoom response review", () => {
  it("animates only the candidate and gates Send until it is revealed", () => {
    const markup = renderRoom({
      draftId: draft.draftId,
      responseVersion: draft.turnId ?? draft.updatedAt,
      firstNewTurnIndex: 0,
    });

    expect(markup.match(/is-typing/g)).toHaveLength(1);
    expect(markup).toContain('disabled="">Reviewing…</button>');
    expect(markup).toContain(draft.privateMessage);
  });

  it("shows recovered candidates immediately with Send enabled", () => {
    const markup = renderRoom(null);

    expect(markup).not.toContain("is-typing");
    expect(markup).toContain('class="send" type="button">Send</button>');
  });
});
