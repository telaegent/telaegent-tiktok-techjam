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

/**
 * What the routing snapshot is looked up by.
 *
 * `grantId` is null for the first ask of a task, when no authority has yet been
 * delegated and the only question is which connector the owner is running.
 */
export interface CapabilityRouteSnapshotQuery {
  authenticatedUserId: UserId;
  ownerUserId: UserId;
  githubRepositoryId: GitHubRepositoryId;
  conversationId: ConversationId;
  taskId: CollaborationTaskId;
  grantId: CapabilityGrantId | null;
}

/** Trusted-server input for reusing an existing grant. */
export interface AuthorizeCapabilityRouteInput extends CapabilityRouteSnapshotQuery {
  grantId: CapabilityGrantId;
  resourceId: ResourceId;
  operation: CapabilityOperation;
}

/** Trusted-server input for an ask that reuses no grant at all. */
export interface ResolveCapabilityRouteInput {
  authenticatedUserId: UserId;
  ownerUserId: UserId;
  githubRepositoryId: GitHubRepositoryId;
  conversationId: ConversationId;
  taskId: CollaborationTaskId;
}

/**
 * Where a grant-less batch may be delivered.
 *
 * This authorizes no read whatsoever. It answers one question - which connector
 * the owner of this repository is running for this task - so that an ask with
 * nothing behind it can still reach a human. Every request carried under it
 * arrives at the connector with no grant, and the only thing the connector may
 * do with it is mint a candidate for a person to approve.
 */
export interface ResolvedCapabilityRoute {
  taskId: CollaborationTaskId;
  ownerUserId: UserId;
  peerUserId: UserId;
  githubRepositoryId: GitHubRepositoryId;
  conversationId: ConversationId;
  ownerRuntimeBindingId: RuntimeBindingId;
  taskExpiresAt: IsoTimestamp;
  requiresLocalAuthorization: true;
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
