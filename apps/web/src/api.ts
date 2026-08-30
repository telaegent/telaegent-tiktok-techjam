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
  roughMessage: string;
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
