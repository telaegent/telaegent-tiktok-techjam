import { z } from "zod";

const postgresBigintId = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);

const githubLogin = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);

const repositoryName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((value) => value !== "." && value !== "..");

// This is intentionally narrower than every ref Git accepts. It supports
// normal GitHub branches while keeping control characters, ref expressions,
// path traversal fragments, and shell metacharacters out of cloud metadata.
const branchName = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => {
    return (
      !/[\x00-\x20\x7f~^:?*[\\]/.test(value) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("//")
    );
  });

export const connectorPrincipalSchema = z.strictObject({
  authenticatedUserId: z.string().uuid(),
  // Supplied by connector authentication, never by the proof request body.
  connectorInstanceId: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export const repositoryProofSchema = z.strictObject({
  version: z.literal(1),
  proofId: z.string().uuid(),
  observedAt: z.string().datetime({ offset: true }),
  github: z.strictObject({
    userId: postgresBigintId,
    login: githubLogin,
  }),
  repository: z.strictObject({
    id: postgresBigintId,
    owner: githubLogin,
    name: repositoryName,
    visibility: z.enum(["public", "private", "internal"]),
    defaultBranch: branchName,
    currentBranch: branchName.nullable(),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    permission: z.enum(["read", "triage", "write", "maintain", "admin"]),
  }),
});

export const repositoryUnavailableSchema = z.strictObject({
  observedAt: z.string().datetime({ offset: true }),
  reason: z.enum([
    "github_auth_required",
    "repository_access_lost",
    "repository_not_found",
    "sso_reauthorization_required",
  ]),
});

export const repositoryProofResultSchema = z.strictObject({
  proofId: z.string().uuid(),
  githubConnectionId: z.string().uuid(),
  projectId: z.string().uuid(),
  githubRepositoryId: postgresBigintId,
  connectorBindingId: z.string().uuid(),
  accessStatus: z.literal("verified"),
  membershipStatus: z.literal("active"),
  bindingStatus: z.literal("ready"),
  verifiedAt: z.string().datetime({ offset: true }),
  replayed: z.boolean(),
});

export const repositoryUnavailableResultSchema = z.strictObject({
  githubRepositoryId: postgresBigintId,
  accessStatus: z.literal("revalidation_required"),
  membershipStatus: z.literal("suspended"),
  bindingStatus: z.literal("unavailable"),
  changed: z.boolean(),
});

export type ConnectorPrincipal = z.infer<typeof connectorPrincipalSchema>;
export type RepositoryProof = z.infer<typeof repositoryProofSchema>;
export type RepositoryUnavailable = z.infer<typeof repositoryUnavailableSchema>;
export type RepositoryProofResult = z.infer<typeof repositoryProofResultSchema>;
export type RepositoryUnavailableResult = z.infer<
  typeof repositoryUnavailableResultSchema
>;
