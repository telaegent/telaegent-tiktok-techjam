import type { GitHubRepositoryId } from "../authorization/types.js";
import type { AgentProvider } from "../runtime-contract.js";
import type { PublicRuntimeErrorCode } from "../runtime-errors.js";
import type { ProtocolRole, RiskFlag } from "../telagent/protocol/contract.js";
import type { GuardFinding } from "../telagent/protocol/guards.js";

export type PrivateDraftState =
  | "created"
  | "agent_working"
  | "needs_clarification"
  | "ready"
  | "blocked"
  | "runtime_failed"
  | "cancelled"
  | "sent";

export interface PrivateDraftFailure {
  code: PublicRuntimeErrorCode;
  message: string;
  retryable: boolean;
}

export interface PrivateDraft {
  draftId: string;
  conversationId: string;
  githubRepositoryId: GitHubRepositoryId;
  ownerUserId: string;
  provider: AgentProvider;
  role: ProtocolRole;
  /** The owner's rough input on a sender draft; optional guidance on a recipient draft. */
  roughMessage: string | null;
  /** The approved collaborator message this draft answers. Recipient drafts only. */
  incomingMessageId: string | null;
  privateTurns: Array<{ speaker: "owner" | "agent"; text: string }>;
  state: PrivateDraftState;
  turnId: string | null;
  privateMessage: string | null;
  sendCandidate: string | null;
  riskFlags: RiskFlag[];
  guardFindings: GuardFinding[];
  failure: PrivateDraftFailure | null;
  createdAt: string;
  updatedAt: string;
  sentMessageId: string | null;
}

export interface SharedMessage {
  messageId: string;
  conversationId: string;
  githubRepositoryId: GitHubRepositoryId;
  senderUserId: string;
  body: string;
  origin: "agent";
  provider: AgentProvider;
  sentAt: string;
}

export interface OutboundApproval {
  approvalId: string;
  draftId: string;
  messageId: string;
  actorUserId: string;
  approvedBody: string;
  idempotencyKey: string;
  approvedAt: string;
}

export interface SendDraftResult {
  message: SharedMessage;
  approval: OutboundApproval;
  replayed: boolean;
}

export interface PrivateDraftView {
  draftId: string;
  conversationId: string;
  githubRepositoryId: GitHubRepositoryId;
  provider: AgentProvider;
  role: ProtocolRole;
  roughMessage: string | null;
  incomingMessageId: string | null;
  privateTurns: Array<{ speaker: "owner" | "agent"; text: string }>;
  state: PrivateDraftState;
  turnId: string | null;
  privateMessage: string | null;
  sendCandidate: string | null;
  riskFlags: RiskFlag[];
  guardFindings: GuardFinding[];
  failure: PrivateDraftFailure | null;
  createdAt: string;
  updatedAt: string;
  sentMessageId: string | null;
}

export function toPrivateDraftView(draft: Readonly<PrivateDraft>): PrivateDraftView {
  return {
    draftId: draft.draftId,
    conversationId: draft.conversationId,
    githubRepositoryId: draft.githubRepositoryId,
    provider: draft.provider,
    role: draft.role,
    roughMessage: draft.roughMessage,
    incomingMessageId: draft.incomingMessageId,
    privateTurns: structuredClone(draft.privateTurns),
    state: draft.state,
    turnId: draft.turnId,
    privateMessage: draft.privateMessage,
    sendCandidate: draft.sendCandidate,
    riskFlags: [...draft.riskFlags],
    guardFindings: structuredClone(draft.guardFindings),
    failure: draft.failure ? { ...draft.failure } : null,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    sentMessageId: draft.sentMessageId,
  };
}
