import type { Agent, AgentRun, Message, SystemInfo } from "./types";

export type AgentProvider = "codex" | "claude";

export type PrivateDraftState =
  | "created"
  | "agent_working"
  | "needs_clarification"
  | "ready"
  | "blocked"
  | "runtime_failed"
  | "cancelled"
  | "sent";

export type PrivateDraftTurn = {
  speaker: "owner" | "agent";
  text: string;
};

export type GuardFinding = {
  code: string;
  safeReason: string;
  impliedFlag: string;
};

export type PrivateDraftFailure = {
  code:
    | "RUNTIME_UNAVAILABLE"
    | "RUNTIME_AUTHENTICATION_FAILED"
    | "RUNTIME_SESSION_NOT_FOUND"
    | "RUNTIME_TIMEOUT"
    | "RUNTIME_OUTPUT_LIMIT"
    | "INVALID_AGENT_OUTPUT"
    | "UNSUPPORTED_RUNTIME_POLICY"
    | "RUNTIME_FAILED"
    | "RUNTIME_CANCELLED";
  message: string;
  retryable: boolean;
};

export type PrivateDraftView = {
  draftId: string;
  conversationId: string;
  githubRepositoryId: string;
  provider: AgentProvider;
  role: "sender" | "recipient";
  /** The owner's rough input on a sender draft; optional steering on a reply. */
  roughMessage: string | null;
  /** The approved collaborator message this draft answers. Replies only. */
  incomingMessageId: string | null;
  privateTurns: PrivateDraftTurn[];
  state: PrivateDraftState;
  turnId: string | null;
  privateMessage: string | null;
  sendCandidate: string | null;
  riskFlags: string[];
  guardFindings: GuardFinding[];
  failure: PrivateDraftFailure | null;
  createdAt: string;
  updatedAt: string;
  sentMessageId: string | null;
};

export type ConversationMessage = {
  messageId: string;
  conversationId: string;
  githubRepositoryId: string;
  senderUserId: string;
  body: string;
  origin: "agent";
  provider: AgentProvider;
  sentAt: string;
};

export type SendDraftResult = {
  message: ConversationMessage;
  approval: {
    approvalId: string;
    draftId: string;
    messageId: string;
    actorUserId: string;
    approvedBody: string;
    idempotencyKey: string;
    approvedAt: string;
  };
  replayed: boolean;
};

export type TelaegentWebUser = {
  userId: string;
  githubUserId: string;
  githubLogin: string;
  avatarUrl: string | null;
};

export type TelaegentSession =
  | { enabled: false; authenticated: false }
  | { enabled: true; authenticated: false }
  | { enabled: true; authenticated: true; user: TelaegentWebUser };

/** A one-time-display local connector credential. Never persist this in browser storage. */
export type ConnectorCredential = {
  credential: string;
  connectorInstanceId: string;
  expiresAt: string;
};

/** Owner-scoped, non-secret state used to verify connector onboarding. */
export type ConnectorSetupStatus = {
  connectorInstanceId: string;
  credential: {
    status: "active" | "expired" | "revoked";
    expiresAt: string;
    lastSeenAt: string | null;
  } | null;
  bindings: Array<{
    connectorBindingId: string;
    projectId: string;
    githubRepositoryId: string;
    repositoryFullName: string;
    visibility: "public" | "private" | "internal";
    defaultBranch: string;
    currentBranch: string | null;
    commitSha: string | null;
    repositoryPermission: "read" | "triage" | "write" | "maintain" | "admin" | null;
    repositoryAccessStatus: "verified" | "revalidation_required" | "revoked";
    membershipStatus: "active" | "suspended" | "revoked";
    bindingStatus: "provisioning" | "ready" | "stopped" | "unavailable" | "revoked";
    verifiedAt: string | null;
    bindingLastSeenAt: string | null;
    unavailableReason: string | null;
  }>;
  bindingsTruncated: boolean;
};

export type ProjectSummary = {
  projectId: string;
  githubRepositoryId: string;
  repositoryFullName: string;
  visibility: "public" | "private" | "internal";
  defaultBranch: string;
  projectStatus: "active" | "archived";
  membershipStatus: "active" | "suspended" | "revoked";
  membershipJoinedAt: string;
  githubConnectionStatus:
    | "connecting"
    | "connected"
    | "reconnect_required"
    | "unavailable"
    | "revoked";
  repositoryAccessStatus: "verified" | "revalidation_required" | "revoked";
  repositoryVerifiedAt: string;
  connectedCollaboratorCount: number;
  binding: {
    connectorBindingId: string;
    connectorInstanceId: string | null;
    status: "provisioning" | "ready" | "stopped" | "unavailable" | "revoked";
    currentBranch: string | null;
    commitSha: string | null;
    repositoryPermission: "read" | "triage" | "write" | "maintain" | "admin" | null;
    lastVerifiedAt: string | null;
    lastSeenAt: string | null;
    unavailableReason: string | null;
  };
};

/**
 * A project member who independently proved access to the same repository.
 *
 * `connectionStatus` is reported from the viewer's own vantage point:
 * `pending_outgoing` means you asked, `pending_incoming` means you were asked
 * and hold the decision.
 */
export type ProjectCollaborator = {
  userId: string;
  githubLogin: string;
  connectionStatus:
    | "none"
    | "pending_outgoing"
    | "pending_incoming"
    | "connected"
    | "revoked";
  projectConnectionId: string | null;
};

export type ProjectConnection = {
  projectConnectionId: string;
  projectId: string;
  requesterUserId: string;
  recipientUserId: string;
  status: "pending" | "connected" | "revoked";
  requestedAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
};

/** The shared conversation for one connected pair. */
export type ProjectConversation = {
  conversationId: string;
  projectId: string;
  githubRepositoryId: string;
  status: "active";
  participantUserIds: string[];
  /** False when the pair's conversation was already open. */
  created: boolean;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
    public readonly retryable = false,
    public readonly findings: GuardFinding[] = [],
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(
      "Telaegent could not reach the conversation service",
      0,
      "NETWORK_ERROR",
      true,
    );
  }
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: unknown;
    code?: unknown;
    retryable?: unknown;
    findings?: unknown;
    details?: unknown;
  };
  if (!response.ok) {
    throw new ApiError(
      typeof data.error === "string" ? data.error : "Request failed",
      response.status,
      typeof data.code === "string" ? data.code : null,
      data.retryable === true,
      Array.isArray(data.findings) ? (data.findings as GuardFinding[]) : [],
      data.details ?? null,
    );
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean; provider: "github" | "disabled" }>("/api/auth"),
  session: () => request<TelaegentSession>("/api/auth/session"),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  issueConnectorCredential: (connectorInstanceId: string) =>
    request<{ connector: ConnectorCredential }>("/api/connectors/credentials", {
      method: "POST",
      body: JSON.stringify({ connectorInstanceId }),
    }),
  connectorSetupStatus: (connectorInstanceId: string) =>
    request<{ connector: ConnectorSetupStatus }>(
      `/api/connectors/installations/${encodeURIComponent(connectorInstanceId)}/status`,
    ),
  projects: (options: { limit?: number; cursor?: string } = {}) => {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return request<{ projects: ProjectSummary[]; nextCursor: string | null }>(
      `/api/projects${suffix}`,
    );
  },
  /**
   * Project members who could be asked to connect, and where each pair stands.
   *
   * Not a GitHub collaborator listing: everyone here connected their own GitHub
   * identity and proved this same repository themselves.
   */
  projectCollaborators: (projectId: string, options: { limit?: number } = {}) => {
    const suffix =
      options.limit === undefined ? "" : `?limit=${String(options.limit)}`;
    return request<{ collaborators: ProjectCollaborator[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/collaborators${suffix}`,
    );
  },
  /** Asks a peer to connect. The recipient still holds the decision. */
  requestProjectConnection: (projectId: string, recipientUserId: string) =>
    request<{ connection: ProjectConnection }>(
      `/api/projects/${encodeURIComponent(projectId)}/connections`,
      { method: "POST", body: JSON.stringify({ recipientUserId }) },
    ),
  /** Accepts or declines a request addressed to you. */
  respondToProjectConnection: (
    projectId: string,
    connectionId: string,
    decision: "accept" | "decline",
  ) =>
    request<{ connection: ProjectConnection }>(
      `/api/projects/${encodeURIComponent(projectId)}/connections/${encodeURIComponent(connectionId)}/respond`,
      { method: "POST", body: JSON.stringify({ decision }) },
    ),
  /** Withdraws or revokes a connection. Either side may do this at any time. */
  revokeProjectConnection: (projectId: string, connectionId: string) =>
    request<{ connection: ProjectConnection }>(
      `/api/projects/${encodeURIComponent(projectId)}/connections/${encodeURIComponent(connectionId)}/revoke`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  /**
   * Opens, or returns, the shared conversation for a connected pair.
   *
   * Idempotent, so it is safe to call whenever a collaborator's thread is
   * entered rather than tracking whether one exists.
   */
  createProjectConversation: (projectId: string, peerUserId: string) =>
    request<{ conversation: ProjectConversation }>(
      `/api/projects/${encodeURIComponent(projectId)}/conversations`,
      { method: "POST", body: JSON.stringify({ peerUserId }) },
    ),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  conversationMessages: (conversationId: string, githubRepositoryId: string) =>
    request<{ messages: ConversationMessage[] }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages?githubRepositoryId=${encodeURIComponent(githubRepositoryId)}`,
    ),
  createConversationDraft: (
    conversationId: string,
    body: {
      githubRepositoryId: string;
      provider: AgentProvider;
      roughMessage: string;
    },
  ) =>
    request<{ draft: PrivateDraftView }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/drafts`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  /**
   * Opens a private draft answering a collaborator's approved message.
   *
   * The reply it returns is owner-private and still leaves only through
   * `sendConversationDraft`, so it faces the same Send/Edit/No gate as a
   * draft the owner started themselves.
   */
  createConversationReply: (
    conversationId: string,
    body: {
      githubRepositoryId: string;
      provider: AgentProvider;
      incomingMessageId: string;
      idempotencyKey: string;
      ownerGuidance?: string;
    },
  ) =>
    request<{ draft: PrivateDraftView; replayed: boolean }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/replies`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  conversationDraft: (draftId: string) =>
    request<{ draft: PrivateDraftView }>(
      `/api/drafts/${encodeURIComponent(draftId)}`,
    ),
  runConversationDraft: (draftId: string) =>
    request<{ draft: PrivateDraftView; pollUrl: string }>(
      `/api/drafts/${encodeURIComponent(draftId)}/run`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    ),
  clarifyConversationDraft: (draftId: string, content: string) =>
    request<{ draft: PrivateDraftView }>(
      `/api/drafts/${encodeURIComponent(draftId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  cancelConversationDraft: (draftId: string) =>
    request<{ draft: PrivateDraftView }>(
      `/api/drafts/${encodeURIComponent(draftId)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    ),
  sendConversationDraft: (
    draftId: string,
    body: { approvedContent?: string; idempotencyKey: string },
  ) =>
    request<SendDraftResult>(
      `/api/drafts/${encodeURIComponent(draftId)}/send`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
};
