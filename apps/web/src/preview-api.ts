import type {
  AgentProvider,
  CapabilityScopeDecisionResult,
  CapabilityScopeRequest,
  ConversationMessage,
  PrivateDraftView,
  ProjectCollaborator,
  ProjectConversation,
  ProjectSummary,
  SendDraftResult,
  TelaegentSession,
} from "./api";

const viewerUserId = "11111111-1111-4111-8111-111111111111";
const peerUserId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const conversationId = "44444444-4444-4444-8444-444444444444";
const githubRepositoryId = "987654321";

const session: TelaegentSession = {
  enabled: true,
  authenticated: true,
  user: {
    userId: viewerUserId,
    githubUserId: "10000001",
    githubLogin: "duy-preview",
    avatarUrl: null,
  },
};

const project: ProjectSummary = {
  projectId,
  githubRepositoryId,
  repositoryFullName: "telaegent/telaegent-platform",
  visibility: "private",
  defaultBranch: "main",
  projectStatus: "active",
  membershipStatus: "active",
  membershipJoinedAt: "2026-08-28T09:00:00.000Z",
  githubConnectionStatus: "connected",
  repositoryAccessStatus: "verified",
  repositoryVerifiedAt: "2026-09-01T00:30:00.000Z",
  connectedCollaboratorCount: 1,
  binding: {
    connectorBindingId: "55555555-5555-4555-8555-555555555555",
    connectorInstanceId: "preview-connector-instance",
    status: "ready",
    currentBranch: "feat/scope-approval-ui",
    commitSha: "909b31e909b31e909b31e909b31e909b31e909b",
    repositoryPermission: "write",
    lastVerifiedAt: "2026-09-01T00:30:00.000Z",
    lastSeenAt: "2026-09-01T00:31:00.000Z",
    unavailableReason: null,
  },
};

const collaborator: ProjectCollaborator = {
  userId: peerUserId,
  githubLogin: "mark-preview",
  connectionStatus: "connected",
  projectConnectionId: "66666666-6666-4666-8666-666666666666",
};

const conversation: ProjectConversation = {
  conversationId,
  projectId,
  githubRepositoryId,
  status: "active",
  participantUserIds: [viewerUserId, peerUserId],
  created: false,
};

let messages: ConversationMessage[] = [
  {
    messageId: "77777777-7777-4777-8777-777777777771",
    conversationId,
    githubRepositoryId,
    senderUserId: peerUserId,
    body: "Can you check whether the new session guard changes our refresh-token behavior before I update the client?",
    origin: "agent",
    provider: "claude",
    sentAt: "2026-09-01T00:20:00.000Z",
  },
  {
    messageId: "77777777-7777-4777-8777-777777777772",
    conversationId,
    githubRepositoryId,
    senderUserId: viewerUserId,
    body: "I'll compare the guard with the current client flow and send back the exact mismatch.",
    origin: "agent",
    provider: "codex",
    sentAt: "2026-09-01T00:23:00.000Z",
  },
];

let scopeRequests: CapabilityScopeRequest[] = [
  {
    scopeRequestId: "88888888-8888-4888-8888-888888888888",
    taskId: "99999999-9999-4999-8999-999999999999",
    conversationId,
    githubRepositoryId,
    peerUserId,
    requestedHint: "apps/server/src/auth/session-policy.ts",
    requestedReason: "Check whether the server's rotation rule matches the client's refresh behavior.",
    operation: "read",
    candidateResourceId: "resource_preview_session_policy_01",
    requestedAt: "2026-09-01T00:29:00.000Z",
    taskExpiresAt: "2026-09-01T01:29:00.000Z",
  },
];

const drafts = new Map<string, PrivateDraftView>();

function jsonBody(options?: RequestInit): Record<string, unknown> {
  if (typeof options?.body !== "string") return {};
  try {
    const value = JSON.parse(options.body) as unknown;
    return typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function now(): string {
  return new Date().toISOString();
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function createDraft(
  provider: AgentProvider,
  role: "sender" | "recipient",
  roughMessage: string | null,
  incomingMessageId: string | null,
): PrivateDraftView {
  const timestamp = now();
  const draft: PrivateDraftView = {
    draftId: crypto.randomUUID(),
    conversationId,
    githubRepositoryId,
    provider,
    role,
    roughMessage,
    incomingMessageId,
    privateTurns: [],
    state: "created",
    turnId: null,
    privateMessage: null,
    sendCandidate: null,
    riskFlags: [],
    guardFindings: [],
    failure: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    sentMessageId: null,
  };
  drafts.set(draft.draftId, draft);
  return copy(draft);
}

function requireDraft(draftId: string): PrivateDraftView {
  const draft = drafts.get(draftId);
  if (!draft) throw new Error("Preview draft was not found");
  return draft;
}

function previewCandidate(draft: PrivateDraftView): string {
  if (draft.role === "recipient") {
    return "The rotation rule invalidates only the token that was consumed. Other device sessions remain active unless token reuse is detected, which revokes the affected session family.";
  }
  return "I compared the session guard with the client refresh path. The guard rejects a reused refresh token and revokes that session family, so the client must serialize refresh attempts across tabs.";
}

/** Query-gated and development-only: production builds can never activate it. */
export function isUiPreviewEnabled(search?: string): boolean {
  if (!import.meta.env.DEV) return false;
  const candidate = search ?? (typeof window === "undefined" ? "" : window.location.search);
  return new URLSearchParams(candidate).get("preview") === "1";
}

/**
 * Small stateful browser fixture for ProductApp development.
 *
 * It deliberately lives below the API client so the real components exercise
 * their ordinary loading, polling, approval, draft, edit, reject and send code.
 */
export async function previewRequest(url: string, options?: RequestInit): Promise<unknown> {
  await Promise.resolve();
  const method = options?.method ?? "GET";

  if (url === "/api/auth/session" && method === "GET") return copy(session);
  if (url === "/api/auth/logout" && method === "POST") return {};
  if (url.startsWith("/api/projects?") && method === "GET") {
    return { projects: [copy(project)], nextCursor: null };
  }
  if (url.match(/^\/api\/projects\/[^/]+\/collaborators(?:\?|$)/) && method === "GET") {
    return { collaborators: [copy(collaborator)] };
  }
  if (url.match(/^\/api\/projects\/[^/]+\/conversations$/) && method === "POST") {
    return { conversation: copy(conversation) };
  }
  if (url.match(/^\/api\/conversations\/[^/]+\/messages\?/) && method === "GET") {
    return { messages: copy(messages) };
  }
  if (url.startsWith("/api/capability/scope-requests?") && method === "GET") {
    return { requests: copy(scopeRequests) };
  }
  if (url.match(/^\/api\/capability\/scope-requests\/[^/]+\/decision$/) && method === "POST") {
    const body = jsonBody(options);
    const encodedId = url.split("/")[4] ?? "";
    const scopeRequestId = decodeURIComponent(encodedId);
    scopeRequests = scopeRequests.filter((request) => request.scopeRequestId !== scopeRequestId);
    const decision = body["decision"];
    const result: CapabilityScopeDecisionResult = decision === "deny"
      ? { outcome: "denied" }
      : {
          outcome: "approved",
          grantId: crypto.randomUUID(),
          mode: decision === "task" ? "task" : "once",
        };
    return result;
  }
  if (url.match(/^\/api\/conversations\/[^/]+\/drafts$/) && method === "POST") {
    const body = jsonBody(options);
    return {
      draft: createDraft(
        body["provider"] === "codex" ? "codex" : "claude",
        "sender",
        typeof body["roughMessage"] === "string" ? body["roughMessage"] : "",
        null,
      ),
    };
  }
  if (url.match(/^\/api\/conversations\/[^/]+\/replies$/) && method === "POST") {
    const body = jsonBody(options);
    return {
      draft: createDraft(
        body["provider"] === "codex" ? "codex" : "claude",
        "recipient",
        typeof body["ownerGuidance"] === "string" ? body["ownerGuidance"] : null,
        typeof body["incomingMessageId"] === "string" ? body["incomingMessageId"] : null,
      ),
      replayed: false,
    };
  }

  const draftMatch = url.match(/^\/api\/drafts\/([^/]+)(?:\/(run|messages|cancel|send))?$/);
  if (draftMatch) {
    const draftId = decodeURIComponent(draftMatch[1] ?? "");
    const action = draftMatch[2];
    const draft = requireDraft(draftId);
    if (!action && method === "GET") return { draft: copy(draft) };
    if (action === "run" && method === "POST") {
      const working: PrivateDraftView = {
        ...draft,
        state: "agent_working",
        turnId: crypto.randomUUID(),
        updatedAt: now(),
      };
      const ready: PrivateDraftView = {
        ...working,
        state: "ready",
        privateMessage: "Preview agent completed the private reasoning pass using fixture context.",
        sendCandidate: previewCandidate(draft),
        updatedAt: now(),
      };
      drafts.set(draftId, ready);
      return { draft: copy(working), pollUrl: `/api/drafts/${draftId}` };
    }
    if (action === "messages" && method === "POST") {
      const body = jsonBody(options);
      const content = typeof body["content"] === "string" ? body["content"] : "";
      const clarified: PrivateDraftView = {
        ...draft,
        state: "created",
        turnId: null,
        privateTurns: [
          ...draft.privateTurns,
          { speaker: "owner", text: content },
        ],
        updatedAt: now(),
      };
      drafts.set(draftId, clarified);
      return { draft: copy(clarified) };
    }
    if (action === "cancel" && method === "POST") {
      const cancelled: PrivateDraftView = { ...draft, state: "cancelled", updatedAt: now() };
      drafts.set(draftId, cancelled);
      return { draft: copy(cancelled) };
    }
    if (action === "send" && method === "POST") {
      const body = jsonBody(options);
      const approvedBody = typeof body["approvedContent"] === "string"
        ? body["approvedContent"]
        : draft.sendCandidate ?? "";
      const timestamp = now();
      const message: ConversationMessage = {
        messageId: crypto.randomUUID(),
        conversationId,
        githubRepositoryId,
        senderUserId: viewerUserId,
        body: approvedBody,
        origin: "agent",
        provider: draft.provider,
        sentAt: timestamp,
      };
      messages = [...messages, message];
      drafts.set(draftId, {
        ...draft,
        state: "sent",
        sentMessageId: message.messageId,
        updatedAt: timestamp,
      });
      const result: SendDraftResult = {
        message,
        approval: {
          approvalId: crypto.randomUUID(),
          draftId,
          messageId: message.messageId,
          actorUserId: viewerUserId,
          approvedBody,
          idempotencyKey: typeof body["idempotencyKey"] === "string"
            ? body["idempotencyKey"]
            : `preview:${draftId}`,
          approvedAt: timestamp,
        },
        replayed: false,
      };
      return copy(result);
    }
  }

  throw new Error(`UI preview has no fixture for ${method} ${url}`);
}
