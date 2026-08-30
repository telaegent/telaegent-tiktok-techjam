/**
 * Canonical authorization-domain types for the Telaegent cloud control plane.
 *
 * These records are deliberately independent of Supabase row shapes, HTTP
 * request bodies, and the preserved legacy Telagent conflict workflow. An
 * infrastructure adapter may map database rows into these records, but product
 * authorization decisions belong to the authorization service.
 */

export type UserId = string;
export type GitHubConnectionId = string;
export type GitHubUserId = string;
/** Positive PostgreSQL BIGINT GitHub repository ID as a canonical decimal string. */
export type GitHubRepositoryId = string;
export type ProjectId = string;
export type ConversationId = string;
export type ProjectConnectionId = string;
export type RuntimeBindingId = string;
export type IsoTimestamp = string;

export type UserAccountStatus = "active" | "disabled" | "deleted";

export interface UserAccount {
  userId: UserId;
  status: UserAccountStatus;
}

export type GitHubConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnect_required"
  | "unavailable"
  | "revoked";

/**
 * Authorization-safe projection of a GitHub connection.
 *
 * Credential references and credential material are intentionally absent.
 * The authorization layer needs connection ownership and health, not secrets.
 */
export interface GitHubConnection {
  githubConnectionId: GitHubConnectionId;
  userId: UserId;
  githubUserId: GitHubUserId;
  githubLogin: string;
  status: GitHubConnectionStatus;
  connectedAt: IsoTimestamp;
  lastVerifiedAt: IsoTimestamp | null;
}

export type GitHubRepositoryAccessStatus =
  | "verified"
  | "revalidation_required"
  | "revoked";

/** Independent proof that one user's GitHub identity can access one repo. */
export interface GitHubRepositoryAccess {
  userId: UserId;
  githubConnectionId: GitHubConnectionId;
  githubRepositoryId: GitHubRepositoryId;
  status: GitHubRepositoryAccessStatus;
  verifiedAt: IsoTimestamp;
}

export type RepositoryVisibility = "public" | "private" | "internal";
export type RepositoryProjectStatus = "active" | "archived";

/** Telaegent project whose external scope key is a GitHub repository ID. */
export interface RepositoryProject {
  projectId: ProjectId;
  githubRepositoryId: GitHubRepositoryId;
  repositoryFullName: string;
  visibility: RepositoryVisibility;
  defaultBranch: string;
  status: RepositoryProjectStatus;
}

export type ProjectMembershipStatus = "active" | "suspended" | "revoked";

/** Telaegent membership is separate from GitHub repository access. */
export interface ProjectMembership {
  projectId: ProjectId;
  userId: UserId;
  status: ProjectMembershipStatus;
  joinedAt: IsoTimestamp;
}

export type ProjectConnectionStatus = "pending" | "connected" | "revoked";

/** Once-per-project, revocable permission for two users to communicate. */
interface ProjectConnectionBase {
  projectConnectionId: ProjectConnectionId;
  projectId: ProjectId;
  requesterUserId: UserId;
  recipientUserId: UserId;
  requestedAt: IsoTimestamp;
}

export type ProjectConnection =
  | (ProjectConnectionBase & {
      status: "pending";
      acceptedAt: null;
      revokedAt: null;
    })
  | (ProjectConnectionBase & {
      status: "connected";
      acceptedAt: IsoTimestamp;
      revokedAt: null;
    })
  | (ProjectConnectionBase & {
      status: "revoked";
      acceptedAt: IsoTimestamp | null;
      revokedAt: IsoTimestamp;
    });

export type ProjectConversationStatus = "active" | "closed";

export interface ProjectConversation {
  conversationId: ConversationId;
  projectId: ProjectId;
  participantUserIds: readonly UserId[];
  status: ProjectConversationStatus;
}

interface RuntimeBindingBase {
  runtimeBindingId: RuntimeBindingId;
  userId: UserId;
  projectId: ProjectId;
  githubRepositoryId: GitHubRepositoryId;
}

/**
 * Cloud projection of an opaque local connector binding. Local workspace,
 * provider-home, credential, and session details intentionally never appear.
 */
export type RuntimeBinding =
  | (RuntimeBindingBase & {
      status: "ready";
    })
  | (RuntimeBindingBase & {
      status: "provisioning" | "stopped" | "unavailable" | "revoked";
    });

/**
 * Internal service input. `authenticatedUserId` must come from trusted server
 * authentication context, never from a user-editable browser field.
 */
export interface AuthorizePrivateRuntimeInput {
  authenticatedUserId: UserId;
  githubRepositoryId: GitHubRepositoryId;
  conversationId: ConversationId;
}

/**
 * Internal result consumed by connector job dispatch. `runtimeBindingId` is an
 * opaque cloud identifier whose path/provider mapping exists only on the
 * owning developer's local connector.
 */
export interface AuthorizedPrivateRuntime {
  userId: UserId;
  githubRepositoryId: GitHubRepositoryId;
  runtimeBindingId: RuntimeBindingId;
}
