import { z } from "zod";
import { isGitHubRepositoryId } from "./github-repository-id.js";
import type {
  CapabilityRouteAuthorizationReadOptions,
  CapabilityRouteAuthorizationRepository,
} from "./capability-repository.js";
import type {
  AuthorizeCapabilityRouteInput,
  CapabilityRouteAuthorizationSnapshot,
} from "./capability-types.js";
import type { GitHubRepositoryId } from "./types.js";

const maximumStringCharacters = 4_096;
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const githubRepositoryIdSchema = z.string().refine(isGitHubRepositoryId);
const isoTimestampSchema = z.string().datetime({ offset: true });
const boundedTextSchema = z
  .string()
  .min(1)
  .max(maximumStringCharacters)
  .refine((value) => !/[\u0000\r\n]/.test(value));

/**
 * Kept byte-for-byte identical to the `resource_capability_grants.resource_id`
 * check constraint and to the connector's local registry, so an identifier that
 * one layer accepts can never be silently rejected by another.
 */
const resourceIdSchema = z.string().regex(/^resource_[A-Za-z0-9_-]{16,120}$/);

const taskSchema = z.strictObject({
  taskId: identifierSchema,
  projectId: identifierSchema,
  conversationId: identifierSchema,
  githubRepositoryId: githubRepositoryIdSchema,
  requesterUserId: identifierSchema,
  responderUserId: identifierSchema,
  originSharedMessageId: identifierSchema,
  status: z.enum(["active", "completed", "cancelled"]),
  createdAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  endedAt: isoTimestampSchema.nullable(),
});

const projectSchema = z.strictObject({
  projectId: identifierSchema,
  githubRepositoryId: githubRepositoryIdSchema,
  repositoryFullName: boundedTextSchema.max(256),
  visibility: z.enum(["public", "private", "internal"]),
  defaultBranch: boundedTextSchema.max(256),
  status: z.enum(["active", "archived"]),
});

const conversationSchema = z.strictObject({
  conversationId: identifierSchema,
  projectId: identifierSchema,
  // Bounded one above a two-peer room so the service observes overflow and
  // refuses, rather than authorizing a wider conversation than the loop allows.
  participantUserIds: z.array(identifierSchema).max(3),
  status: z.enum(["active", "closed"]),
});

const membershipSchema = z.strictObject({
  projectId: identifierSchema,
  userId: identifierSchema,
  status: z.enum(["active", "suspended", "revoked"]),
  joinedAt: isoTimestampSchema,
});

const projectConnectionBase = {
  projectConnectionId: identifierSchema,
  projectId: identifierSchema,
  requesterUserId: identifierSchema,
  recipientUserId: identifierSchema,
  requestedAt: isoTimestampSchema,
} as const;
const projectConnectionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...projectConnectionBase,
    status: z.literal("pending"),
    acceptedAt: z.null(),
    revokedAt: z.null(),
  }),
  z.strictObject({
    ...projectConnectionBase,
    status: z.literal("connected"),
    acceptedAt: isoTimestampSchema,
    revokedAt: z.null(),
  }),
  z.strictObject({
    ...projectConnectionBase,
    status: z.literal("revoked"),
    acceptedAt: isoTimestampSchema.nullable(),
    revokedAt: isoTimestampSchema,
  }),
]);

const runtimeBindingSchema = z.strictObject({
  runtimeBindingId: identifierSchema,
  userId: identifierSchema,
  projectId: identifierSchema,
  githubRepositoryId: githubRepositoryIdSchema,
  status: z.enum(["provisioning", "ready", "stopped", "unavailable", "revoked"]),
});

/**
 * The cloud projection of one delegated authority.
 *
 * `operation` is a literal rather than an enum: a payload that ever claimed
 * write or execute authority is malformed, not merely unauthorized, and must be
 * rejected before any policy code can read it.
 */
const grantSchema = z.strictObject({
  grantId: identifierSchema,
  taskId: identifierSchema,
  ownerUserId: identifierSchema,
  peerUserId: identifierSchema,
  resourceId: resourceIdSchema,
  operation: z.literal("read"),
  mode: z.enum(["once", "task"]),
  status: z.enum(["active", "consumed", "revoked", "expired"]),
  grantedByUserId: identifierSchema,
  grantedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  consumedAt: isoTimestampSchema.nullable(),
  revokedAt: isoTimestampSchema.nullable(),
});

const snapshotSchema = z.strictObject({
  task: taskSchema.nullable(),
  project: projectSchema.nullable(),
  conversation: conversationSchema.nullable(),
  requesterMembership: membershipSchema.nullable(),
  ownerMembership: membershipSchema.nullable(),
  projectConnection: projectConnectionSchema.nullable(),
  ownerRuntimeBinding: runtimeBindingSchema.nullable(),
  grant: grantSchema.nullable(),
});

/** Persistence DTO, independent of the physical table and column layout. */
export type SupabaseCapabilityRouteSnapshotDto = z.input<typeof snapshotSchema>;

export interface SupabaseCapabilityRouteRpcRequest {
  peerUserId: string;
  ownerUserId: string;
  githubRepositoryId: GitHubRepositoryId;
  conversationId: string;
  taskId: string;
  grantId: string;
}

export interface SupabaseCapabilitySnapshotClient {
  /**
   * Calls one RPC and returns its untrusted JSON result. Implementations must
   * project BIGINT repository IDs as decimal text and must never select
   * canonical paths, file contents, credentials or provider session IDs.
   */
  fetchCapabilityRouteAuthorizationSnapshot(
    request: Readonly<SupabaseCapabilityRouteRpcRequest>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown>;
}

export type SupabaseCapabilityRepositoryErrorCode =
  | "SUPABASE_CAPABILITY_UNAVAILABLE"
  | "INVALID_SUPABASE_CAPABILITY_SNAPSHOT";

/** Safe infrastructure error: never includes row data, identifiers or issues. */
export class SupabaseCapabilityRepositoryError extends Error {
  constructor(public readonly code: SupabaseCapabilityRepositoryErrorCode) {
    super(
      code === "SUPABASE_CAPABILITY_UNAVAILABLE"
        ? "Capability persistence is temporarily unavailable"
        : "Capability persistence returned an invalid snapshot",
    );
    this.name = "SupabaseCapabilityRepositoryError";
  }
}

/**
 * Maps untrusted PostgREST JSON into capability-safe domain facts.
 *
 * Shape only. Whether the task is live, the grant still active, the peers
 * consistent or the binding ready remains CapabilityRouteAuthorizationService's
 * decision, so a persistence change can never quietly become a policy change.
 */
export function mapSupabaseCapabilityRouteSnapshot(
  payload: unknown,
): CapabilityRouteAuthorizationSnapshot {
  const parsed = snapshotSchema.safeParse(payload);
  if (!parsed.success) {
    throw new SupabaseCapabilityRepositoryError(
      "INVALID_SUPABASE_CAPABILITY_SNAPSHOT",
    );
  }
  return parsed.data;
}

/**
 * Supabase-backed implementation of the capability routing seam.
 *
 * This is the only thing that made CapabilityRouteAuthorizationService
 * reachable: the tables existed, but nothing could read them.
 */
export class SupabaseCapabilityRouteAuthorizationRepository
  implements CapabilityRouteAuthorizationRepository
{
  constructor(private readonly client: SupabaseCapabilitySnapshotClient) {}

  async loadCapabilityRouteAuthorizationSnapshot(
    input: Readonly<AuthorizeCapabilityRouteInput>,
    options?: Readonly<CapabilityRouteAuthorizationReadOptions>,
  ): Promise<CapabilityRouteAuthorizationSnapshot> {
    throwIfAborted(options?.signal);

    let payload: unknown;
    try {
      payload = await this.client.fetchCapabilityRouteAuthorizationSnapshot(
        {
          peerUserId: input.authenticatedUserId,
          ownerUserId: input.ownerUserId,
          githubRepositoryId: input.githubRepositoryId,
          conversationId: input.conversationId,
          taskId: input.taskId,
          grantId: input.grantId,
        },
        options?.signal ? { signal: options.signal } : undefined,
      );
    } catch (error) {
      if (options?.signal?.aborted || isAbortError(error)) throw abortError();
      throw new SupabaseCapabilityRepositoryError("SUPABASE_CAPABILITY_UNAVAILABLE");
    }

    throwIfAborted(options?.signal);
    return mapSupabaseCapabilityRouteSnapshot(payload);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Capability persistence read aborted");
  error.name = "AbortError";
  return error;
}
