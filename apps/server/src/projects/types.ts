import { z } from "zod";
import { isGitHubRepositoryId } from "../authorization/github-repository-id.js";

const timestamp = z.string().datetime({ offset: true });
const githubRepositoryId = z.string().refine(isGitHubRepositoryId);

export const projectSummarySchema = z.strictObject({
  projectId: z.string().uuid(),
  githubRepositoryId,
  repositoryFullName: z.string().min(3).max(140),
  visibility: z.enum(["public", "private", "internal"]),
  defaultBranch: z.string().min(1).max(255),
  projectStatus: z.enum(["active", "archived"]),
  membershipStatus: z.enum(["active", "suspended", "revoked"]),
  membershipJoinedAt: timestamp,
  githubConnectionStatus: z.enum([
    "connecting",
    "connected",
    "reconnect_required",
    "unavailable",
    "revoked",
  ]),
  repositoryAccessStatus: z.enum(["verified", "revalidation_required", "revoked"]),
  repositoryVerifiedAt: timestamp,
  connectedCollaboratorCount: z.number().int().nonnegative().max(1_000_000),
  binding: z.strictObject({
    connectorBindingId: z.string().uuid(),
    connectorInstanceId: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable(),
    status: z.enum(["provisioning", "ready", "stopped", "unavailable", "revoked"]),
    currentBranch: z.string().min(1).max(255).nullable(),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    repositoryPermission: z
      .enum(["read", "triage", "write", "maintain", "admin"])
      .nullable(),
    lastVerifiedAt: timestamp.nullable(),
    lastSeenAt: timestamp.nullable(),
    unavailableReason: z.string().min(1).max(64).nullable(),
  }),
});

export const projectSummaryRowsSchema = z.array(projectSummarySchema).max(51);

export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export interface ProjectListPage {
  projects: ProjectSummary[];
  nextCursor: string | null;
}

/**
 * A project member who has independently proved access to the same repository,
 * with the state of any connection between them and the caller.
 *
 * The shape is deliberately narrow. Eligibility to be asked is not a licence to
 * learn about someone: this carries identity and connection state only, never a
 * workspace path, branch, binding, credential, or provider detail.
 */
export const projectCollaboratorSchema = z.strictObject({
  userId: z.string().uuid(),
  githubLogin: z.string().min(1).max(39),
  /**
   * Reported from the caller's own vantage point. `pending_outgoing` means the
   * caller asked; `pending_incoming` means the caller was asked and holds the
   * decision.
   */
  connectionStatus: z.enum([
    "none",
    "pending_outgoing",
    "pending_incoming",
    "connected",
    "revoked",
  ]),
  projectConnectionId: z.string().uuid().nullable(),
});

export const projectCollaboratorRowsSchema = z
  .array(projectCollaboratorSchema)
  .max(51);

export type ProjectCollaborator = z.infer<typeof projectCollaboratorSchema>;

/** One durable connection row for an unordered pair within one project. */
export const projectConnectionSchema = z.strictObject({
  projectConnectionId: z.string().uuid(),
  projectId: z.string().uuid(),
  requesterUserId: z.string().uuid(),
  recipientUserId: z.string().uuid(),
  status: z.enum(["pending", "connected", "revoked"]),
  requestedAt: timestamp,
  acceptedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
});

export type ProjectConnection = z.infer<typeof projectConnectionSchema>;

/**
 * The shared conversation for one connected pair. `created` is false when the
 * pair's conversation was already open, which is the common case once a
 * collaboration is under way.
 */
export const projectConversationSchema = z.strictObject({
  conversationId: z.string().uuid(),
  projectId: z.string().uuid(),
  githubRepositoryId,
  status: z.literal("active"),
  participantUserIds: z.array(z.string().uuid()).length(2),
  created: z.boolean(),
});

export type ProjectConversation = z.infer<typeof projectConversationSchema>;

/**
 * Result of a deliberate browser-side repository disconnect.
 *
 * `stopped` is intentionally reconnectable: a fresh local connector proof may
 * establish the binding again, while the old connector instance and every
 * active task/grant lose authority immediately.
 */
export const projectDisconnectSchema = z.strictObject({
  projectId: z.string().uuid(),
  githubRepositoryId,
  repositoryAccessStatus: z.literal("revalidation_required"),
  membershipStatus: z.literal("suspended"),
  bindingStatus: z.literal("stopped"),
  disconnectedAt: timestamp,
  changed: z.boolean(),
});

export type ProjectDisconnect = z.infer<typeof projectDisconnectSchema>;
