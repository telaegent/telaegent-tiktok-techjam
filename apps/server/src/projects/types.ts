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
