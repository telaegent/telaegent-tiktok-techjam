import { z } from "zod";
import { SupabaseCapabilityRepositoryError } from "./supabase-capability-repository.js";

/**
 * Redemption of authority a human already delegated.
 *
 * This is what makes "Allow once" mean once. The database holds the row lock,
 * so two rounds racing the same grant serialize there and the loser sees a
 * consumed grant rather than a second read. Nothing here decides whether a file
 * may be opened; the owner's connector remains the reference monitor.
 */

const consumeOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("consumed"), mode: z.literal("once") }),
  z.object({ outcome: z.literal("reusable"), mode: z.literal("task") }),
  z.object({ outcome: z.literal("expired") }),
  // One outcome for every way a grant can fail to apply. Distinguishing them
  // would let a peer probe which grants exist for other resources.
  z.object({ outcome: z.literal("unavailable") }),
]);

/**
 * The authority a peer is already holding inside one task.
 *
 * A grant survives the round it was approved in, so a later turn has to be able
 * to read the ledger back. Only identifiers come out: the resource identifier
 * is opaque, and nothing here says what any of them point at.
 */
const listOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("listed"),
    grants: z
      .array(
        z.object({
          grantId: z.string().uuid(),
          resourceId: z.string().regex(/^resource_[A-Za-z0-9_-]{16,120}$/u),
        }),
      )
      .max(64),
  }),
  z.object({ outcome: z.literal("unavailable") }),
]);

export type ConsumeCapabilityGrantOutcome = z.infer<typeof consumeOutcomeSchema>;
export type ListTaskCapabilityGrantsOutcome = z.infer<typeof listOutcomeSchema>;

export interface ListTaskCapabilityGrantsInput {
  taskId: string;
  ownerUserId: string;
  peerUserId: string;
}

export interface ConsumeCapabilityGrantInput {
  grantId: string;
  ownerUserId: string;
  peerUserId: string;
  resourceId: string;
}

export interface CapabilityGrantRepository {
  consumeGrant(
    input: Readonly<ConsumeCapabilityGrantInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<ConsumeCapabilityGrantOutcome>;
  listTaskGrants(
    input: Readonly<ListTaskCapabilityGrantsInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<ListTaskCapabilityGrantsOutcome>;
}

export interface SupabaseCapabilityGrantClient {
  consumeCapabilityGrant(
    request: Readonly<ConsumeCapabilityGrantInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown>;
  listTaskCapabilityGrants(
    request: Readonly<ListTaskCapabilityGrantsInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown>;
}

export class SupabaseCapabilityGrantRepository
  implements CapabilityGrantRepository
{
  constructor(private readonly client: SupabaseCapabilityGrantClient) {}

  async consumeGrant(
    input: Readonly<ConsumeCapabilityGrantInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<ConsumeCapabilityGrantOutcome> {
    if (options?.signal?.aborted) throw abortError();
    let payload: unknown;
    try {
      payload = await this.client.consumeCapabilityGrant(
        input,
        options?.signal ? { signal: options.signal } : undefined,
      );
    } catch (error) {
      if (options?.signal?.aborted || isAbortError(error)) throw abortError();
      throw new SupabaseCapabilityRepositoryError(
        "SUPABASE_CAPABILITY_UNAVAILABLE",
      );
    }
    return parse(consumeOutcomeSchema, payload);
  }

  /**
   * Reads back which resources a human already allowed for this task.
   *
   * This grants nothing. It only lets a following round assert authority that
   * already exists, instead of asking the same person the same question again.
   */
  async listTaskGrants(
    input: Readonly<ListTaskCapabilityGrantsInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<ListTaskCapabilityGrantsOutcome> {
    if (options?.signal?.aborted) throw abortError();
    let payload: unknown;
    try {
      payload = await this.client.listTaskCapabilityGrants(
        input,
        options?.signal ? { signal: options.signal } : undefined,
      );
    } catch (error) {
      if (options?.signal?.aborted || isAbortError(error)) throw abortError();
      throw new SupabaseCapabilityRepositoryError(
        "SUPABASE_CAPABILITY_UNAVAILABLE",
      );
    }
    return parse(listOutcomeSchema, payload);
  }
}

/**
 * Validation failures never carry their issues outward.
 *
 * A report of what did not parse would describe the row, and the row says who
 * is allowed to read what inside somebody's repository.
 */
function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new SupabaseCapabilityRepositoryError(
      "INVALID_SUPABASE_CAPABILITY_SNAPSHOT",
    );
  }
  return parsed.data;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Capability grant redemption aborted");
  error.name = "AbortError";
  return error;
}
