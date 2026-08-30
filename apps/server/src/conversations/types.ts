import type { GitHubRepositoryId } from "../authorization/types.js";
import type { AgentProvider } from "../runtime-contract.js";
import type { RiskFlag } from "../telagent/protocol/contract.js";
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

export interface PrivateDraft {
  draftId: string;
  conversationId: string;
  githubRepositoryId: GitHubRepositoryId;
  ownerUserId: string;
  provider: AgentProvider;
  roughMessage: string;
  privateTurns: Array<{ speaker: "owner" | "agent"; text: string }>;
  state: PrivateDraftState;
  turnId: string | null;
  privateMessage: string | null;
  sendCandidate: string | null;
  riskFlags: RiskFlag[];
  guardFindings: GuardFinding[];
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
  roughMessage: string;
  privateTurns: Array<{ speaker: "owner" | "agent"; text: string }>;
  state: PrivateDraftState;
  turnId: string | null;
  privateMessage: string | null;
  sendCandidate: string | null;
  riskFlags: RiskFlag[];
  guardFindings: GuardFinding[];
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
    roughMessage: draft.roughMessage,
    privateTurns: structuredClone(draft.privateTurns),
    state: draft.state,
    turnId: draft.turnId,
    privateMessage: draft.privateMessage,
    sendCandidate: draft.sendCandidate,
    riskFlags: [...draft.riskFlags],
    guardFindings: structuredClone(draft.guardFindings),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    sentMessageId: draft.sentMessageId,
  };
}
