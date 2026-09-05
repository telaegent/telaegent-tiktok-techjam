import { z } from "zod";
import { resourceDisplayLabelSchema } from "../connectors/resource-request.js";
import { isGitHubRepositoryId } from "./github-repository-id.js";
import { SupabaseCapabilityRepositoryError } from "./supabase-capability-repository.js";
import type { GitHubRepositoryId } from "./types.js";

const uuidSchema = z.string().uuid();
const isoTimestampSchema = z.string().datetime({ offset: true });
const resourceIdSchema = z.string().regex(/^resource_[A-Za-z0-9_-]{16,120}$/u);

const ownedGrantSchema = z.strictObject({
  grantId: uuidSchema,
  taskId: uuidSchema,
  conversationId: uuidSchema,
  githubRepositoryId: z.string().refine(isGitHubRepositoryId),
  peerUserId: uuidSchema,
  resourceId: resourceIdSchema,
  resourceDisplayLabel: resourceDisplayLabelSchema,
  operation: z.literal("read"),
  mode: z.enum(["once", "task"]),
  grantedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
});

const ownedGrantListSchema = z.array(ownedGrantSchema).max(200);
const revokeOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("revoked") }),
  // Missing, another owner's, consumed and expired grants deliberately share
  // one result so an identifier cannot be used to inspect another task.
  z.object({ outcome: z.literal("unavailable") }),
]);

export type OwnedCapabilityGrant = z.infer<typeof ownedGrantSchema> & {
  githubRepositoryId: GitHubRepositoryId;
};
export type RevokeOwnedCapabilityGrantOutcome = z.infer<
  typeof revokeOutcomeSchema
>;

export interface ListOwnedCapabilityGrantsInput {
  ownerUserId: string;
  githubRepositoryId: GitHubRepositoryId;
}

export interface RevokeOwnedCapabilityGrantInput {
  ownerUserId: string;
  grantId: string;
}

export interface OwnedCapabilityGrantRepository {
  listOwnedGrants(
    input: Readonly<ListOwnedCapabilityGrantsInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<readonly OwnedCapabilityGrant[]>;
  revokeOwnedGrant(
    input: Readonly<RevokeOwnedCapabilityGrantInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<RevokeOwnedCapabilityGrantOutcome>;
}

export interface SupabaseOwnedCapabilityGrantClient {
  listOwnedCapabilityGrants(
    request: Readonly<ListOwnedCapabilityGrantsInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown>;
  revokeOwnedCapabilityGrant(
    request: Readonly<RevokeOwnedCapabilityGrantInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown>;
}

export class SupabaseOwnedCapabilityGrantRepository
  implements OwnedCapabilityGrantRepository
{
  constructor(private readonly client: SupabaseOwnedCapabilityGrantClient) {}

  async listOwnedGrants(
    input: Readonly<ListOwnedCapabilityGrantsInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<readonly OwnedCapabilityGrant[]> {
    return this.#call(
      ownedGrantListSchema,
      (signal) => this.client.listOwnedCapabilityGrants(input, signal),
      options,
    ) as Promise<readonly OwnedCapabilityGrant[]>;
  }

  revokeOwnedGrant(
    input: Readonly<RevokeOwnedCapabilityGrantInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<RevokeOwnedCapabilityGrantOutcome> {
    return this.#call(
      revokeOutcomeSchema,
      (signal) => this.client.revokeOwnedCapabilityGrant(input, signal),
      options,
    );
  }

  async #call<T>(
    schema: z.ZodType<T>,
    invoke: (
      options?: Readonly<{ signal?: AbortSignal | undefined }>,
    ) => Promise<unknown>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<T> {
    throwIfAborted(options?.signal);
    let payload: unknown;
    try {
      payload = await invoke(
        options?.signal ? { signal: options.signal } : undefined,
      );
    } catch (error) {
      if (options?.signal?.aborted || isAbortError(error)) throw abortError();
      throw new SupabaseCapabilityRepositoryError(
        "SUPABASE_CAPABILITY_UNAVAILABLE",
      );
    }
    throwIfAborted(options?.signal);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new SupabaseCapabilityRepositoryError(
        "INVALID_SUPABASE_CAPABILITY_SNAPSHOT",
      );
    }
    return parsed.data;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Capability grant management aborted");
  error.name = "AbortError";
  return error;
}
