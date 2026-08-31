import type {
  ConversationId,
  GitHubRepositoryId,
  IsoTimestamp,
  ProjectConnection,
  ProjectConversation,
  ProjectId,
  ProjectMembership,
  RepositoryProject,
  RuntimeBinding,
  RuntimeBindingId,
  UserId,
} from "./types.js";

export type CollaborationTaskId = string;
export type CapabilityGrantId = string;
/** Opaque cloud-safe identifier. Its canonical path mapping remains local. */
export type ResourceId = string;

export type CollaborationTaskStatus = "active" | "completed" | "cancelled";

/** Durable identity for one bounded two-peer collaboration. */
export interface CollaborationTask {
  taskId: CollaborationTaskId;
  projectId: ProjectId;
  conversationId: ConversationId;
  githubRepositoryId: GitHubRepositoryId;
  requesterUserId: UserId;
  responderUserId: UserId;
  originSharedMessageId: string;
  status: CollaborationTaskStatus;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  endedAt: IsoTimestamp | null;
}

export type CapabilityOperation = "read";
export type CapabilityGrantMode = "once" | "task";
export type CapabilityGrantStatus = "active" | "consumed" | "revoked" | "expired";

/**
 * Safe cloud projection of authority one human already delegated.
 *
 * No path, file content, directory, glob, credential, or write/execute mode can
 * be represented here. This record permits routing only; the owner's local
 * connector remains the reference monitor and re-checks before every read.
 */
export interface ResourceCapabilityGrant {
  grantId: CapabilityGrantId;
  taskId: CollaborationTaskId;
  ownerUserId: UserId;
  peerUserId: UserId;
  resourceId: ResourceId;
  operation: CapabilityOperation;
  mode: CapabilityGrantMode;
  status: CapabilityGrantStatus;
  grantedByUserId: UserId;
  grantedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  consumedAt: IsoTimestamp | null;
  revokedAt: IsoTimestamp | null;
}

/** Trusted-server input for reusing an existing grant. */
export interface AuthorizeCapabilityRouteInput {
  authenticatedUserId: UserId;
  ownerUserId: UserId;
  githubRepositoryId: GitHubRepositoryId;
  conversationId: ConversationId;
  taskId: CollaborationTaskId;
  grantId: CapabilityGrantId;
  resourceId: ResourceId;
  operation: CapabilityOperation;
}

/**
 * What the cloud may route to the owner's connector after checking metadata.
 * `requiresLocalAuthorization` is deliberately literal: this is never a cloud
 * decision that a file may be opened.
 */
export interface AuthorizedCapabilityRoute {
  taskId: CollaborationTaskId;
  grantId: CapabilityGrantId;
  resourceId: ResourceId;
  operation: "read";
  ownerUserId: UserId;
  peerUserId: UserId;
  githubRepositoryId: GitHubRepositoryId;
  conversationId: ConversationId;
  ownerRuntimeBindingId: RuntimeBindingId;
  grantMode: CapabilityGrantMode;
  grantExpiresAt: IsoTimestamp;
  requiresLocalAuthorization: true;
}

/** One consistent fact snapshot; the repository never decides permission. */
export interface CapabilityRouteAuthorizationSnapshot {
  task: CollaborationTask | null;
  project: RepositoryProject | null;
  conversation: ProjectConversation | null;
  requesterMembership: ProjectMembership | null;
  ownerMembership: ProjectMembership | null;
  projectConnection: ProjectConnection | null;
  ownerRuntimeBinding: RuntimeBinding | null;
  grant: ResourceCapabilityGrant | null;
}
