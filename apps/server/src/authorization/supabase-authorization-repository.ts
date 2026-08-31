import { z } from "zod";
import { isGitHubRepositoryId } from "./github-repository-id.js";
import type {
  PrivateRuntimeAuthorizationReadOptions,
  PrivateRuntimeAuthorizationRepository,
  PrivateRuntimeAuthorizationSnapshot,
} from "./repository.js";
import type {
  AuthorizePrivateRuntimeInput,
  GitHubRepositoryId,
} from "./types.js";

const defaultMaximumProjectConnections = 100;
const maximumStringCharacters = 4_096;
const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const githubRepositoryIdSchema = z
  .string()
  .refine(isGitHubRepositoryId);
const githubNumericUserIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/);
const isoTimestampSchema = z.string().datetime({ offset: true });
const boundedTextSchema = z
  .string()
  .min(1)
  .max(maximumStringCharacters)
  .refine((value) => !/[\u0000\r\n]/.test(value));

const userSchema = z.strictObject({
  userId: identifierSchema,
  status: z.enum(["active", "disabled", "deleted"]),
});

const githubConnectionSchema = z.strictObject({
  githubConnectionId: identifierSchema,
  userId: identifierSchema,
  githubUserId: githubNumericUserIdSchema,
  githubLogin: boundedTextSchema.max(100),
  status: z.enum([
    "connecting",
    "connected",
    "reconnect_required",
    "unavailable",
    "revoked",
  ]),
  connectedAt: isoTimestampSchema,
  lastVerifiedAt: isoTimestampSchema.nullable(),
});

const repositoryAccessSchema = z.strictObject({
  userId: identifierSchema,
  githubConnectionId: identifierSchema,
  githubRepositoryId: githubRepositoryIdSchema,
  status: z.enum(["verified", "revalidation_required", "revoked"]),
  verifiedAt: isoTimestampSchema,
});

const projectSchema = z.strictObject({
  projectId: identifierSchema,
  githubRepositoryId: githubRepositoryIdSchema,
  repositoryFullName: boundedTextSchema.max(256),
  visibility: z.enum(["public", "private", "internal"]),
  defaultBranch: boundedTextSchema.max(256),
  status: z.enum(["active", "archived"]),
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

const readyRuntimeBindingSchema = z.strictObject({
  runtimeBindingId: identifierSchema,
  userId: identifierSchema,
  projectId: identifierSchema,
  githubRepositoryId: githubRepositoryIdSchema,
  status: z.literal("ready"),
});
const unavailableRuntimeBindingSchema = z.strictObject({
  runtimeBindingId: identifierSchema,
  userId: identifierSchema,
  projectId: identifierSchema,
  githubRepositoryId: githubRepositoryIdSchema,
  status: z.enum(["provisioning", "stopped", "unavailable", "revoked"]),
});
const runtimeBindingSchema = z.discriminatedUnion("status", [
  readyRuntimeBindingSchema,
  unavailableRuntimeBindingSchema,
]);

export interface SupabasePrivateRuntimeAuthorizationRpcRequest {
  authenticatedUserId: string;
  githubRepositoryId: GitHubRepositoryId;
  conversationId: string;
  maximumProjectConnections: number;
}

export interface SupabaseAuthorizationSnapshotClient {
  /**
   * Calls one RPC/database transaction and returns its untrusted JSON result.
   * Implementations must project BIGINT repository IDs as decimal text and
   * must not select credentials, secret references, or provider session IDs.
   */
  fetchPrivateRuntimeAuthorizationSnapshot(
    request: Readonly<SupabasePrivateRuntimeAuthorizationRpcRequest>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown>;
}

export type SupabaseAuthorizationRepositoryErrorCode =
  | "SUPABASE_AUTHORIZATION_UNAVAILABLE"
  | "INVALID_SUPABASE_AUTHORIZATION_SNAPSHOT";

/** Safe infrastructure error: never includes row data, paths, or Zod issues. */
export class SupabaseAuthorizationRepositoryError extends Error {
  constructor(public readonly code: SupabaseAuthorizationRepositoryErrorCode) {
    super(
      code === "SUPABASE_AUTHORIZATION_UNAVAILABLE"
        ? "Authorization persistence is temporarily unavailable"
        : "Authorization persistence returned an invalid snapshot",
    );
    this.name = "SupabaseAuthorizationRepositoryError";
  }
}

/**
 * Persistence DTO inferred from the strict RPC response schema. It is
 * intentionally independent of Thai's table and column layout.
 */
export type SupabasePrivateRuntimeAuthorizationSnapshotDto = z.input<
  ReturnType<typeof createSnapshotSchema>
>;

/**
 * Maps untrusted Supabase/PostgREST JSON into authorization-safe domain facts.
 * It validates shape only; active/revoked permission decisions remain in
 * PrivateRuntimeAuthorizationService.
 */
export function mapSupabasePrivateRuntimeAuthorizationSnapshot(
  payload: unknown,
  maximumProjectConnections = defaultMaximumProjectConnections,
): PrivateRuntimeAuthorizationSnapshot {
  assertMaximumProjectConnections(maximumProjectConnections);
  const parsed = createSnapshotSchema(maximumProjectConnections).safeParse(payload);
  if (!parsed.success) {
    throw new SupabaseAuthorizationRepositoryError(
      "INVALID_SUPABASE_AUTHORIZATION_SNAPSHOT",
    );
  }
  return parsed.data;
}

/**
 * Supabase-backed implementation of the existing persistence-neutral seam.
 * Thai can implement SupabaseAuthorizationSnapshotClient with `supabase.rpc`
 * without coupling authorization policy to the SDK or physical schema.
 */
export class SupabasePrivateRuntimeAuthorizationRepository
  implements PrivateRuntimeAuthorizationRepository
{
  constructor(private readonly client: SupabaseAuthorizationSnapshotClient) {}

  async loadPrivateRuntimeAuthorizationSnapshot(
    input: Readonly<AuthorizePrivateRuntimeInput>,
    options?: Readonly<PrivateRuntimeAuthorizationReadOptions>,
  ): Promise<PrivateRuntimeAuthorizationSnapshot> {
    const maximumProjectConnections =
      options?.maximumProjectConnections ?? defaultMaximumProjectConnections;
    assertMaximumProjectConnections(maximumProjectConnections);
    throwIfAborted(options?.signal);

    let payload: unknown;
    try {
      payload = await this.client.fetchPrivateRuntimeAuthorizationSnapshot(
        {
          authenticatedUserId: input.authenticatedUserId,
          githubRepositoryId: input.githubRepositoryId,
          conversationId: input.conversationId,
          maximumProjectConnections,
        },
        options?.signal ? { signal: options.signal } : undefined,
      );
    } catch (error) {
      if (options?.signal?.aborted || isAbortError(error)) {
        throw abortError();
      }
      throw new SupabaseAuthorizationRepositoryError(
        "SUPABASE_AUTHORIZATION_UNAVAILABLE",
      );
    }

    throwIfAborted(options?.signal);
    return mapSupabasePrivateRuntimeAuthorizationSnapshot(
      payload,
      maximumProjectConnections,
    );
  }
}

function createSnapshotSchema(maximumProjectConnections: number) {
  const conversationSchema = z
    .strictObject({
      conversationId: identifierSchema,
      projectId: identifierSchema,
      participantUserIds: z
        .array(identifierSchema)
        .min(2)
        .max(maximumProjectConnections + 2),
      status: z.enum(["active", "closed"]),
    })
    .superRefine((conversation, context) => {
      if (
        new Set(conversation.participantUserIds).size !==
        conversation.participantUserIds.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Conversation participants must be unique",
        });
      }
    });

  const projectConnectionsSchema = z
    .array(projectConnectionSchema)
    .max(maximumProjectConnections + 1)
    .superRefine((connections, context) => {
      const ids = new Set<string>();
      const pairs = new Set<string>();
      for (const connection of connections) {
        const pair = [
          connection.requesterUserId,
          connection.recipientUserId,
        ].sort();
        const pairKey = [connection.projectId, pair[0], pair[1]].join("\u0000");
        if (
          connection.requesterUserId === connection.recipientUserId ||
          ids.has(connection.projectConnectionId) ||
          pairs.has(pairKey)
        ) {
          context.addIssue({
            code: "custom",
            message: "Project connections must be unique",
          });
          return;
        }
        ids.add(connection.projectConnectionId);
        pairs.add(pairKey);
      }
    });

  return z.strictObject({
    user: userSchema.nullable(),
    githubConnection: githubConnectionSchema.nullable(),
    repositoryAccess: repositoryAccessSchema.nullable(),
    project: projectSchema.nullable(),
    membership: membershipSchema.nullable(),
    conversation: conversationSchema.nullable(),
    projectConnections: projectConnectionsSchema,
    runtimeBinding: runtimeBindingSchema.nullable(),
  });
}

function assertMaximumProjectConnections(value: number): void {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > defaultMaximumProjectConnections
  ) {
    throw new Error("Invalid Supabase authorization read options");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Authorization persistence read aborted");
  error.name = "AbortError";
  return error;
}
