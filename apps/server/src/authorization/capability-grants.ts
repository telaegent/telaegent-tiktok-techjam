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

export type ConsumeCapabilityGrantOutcome = z.infer<typeof consumeOutcomeSchema>;

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
}

export interface SupabaseCapabilityGrantClient {
  consumeCapabilityGrant(
    request: Readonly<ConsumeCapabilityGrantInput>,
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
    const parsed = consumeOutcomeSchema.safeParse(payload);
    if (!parsed.success) {
      throw new SupabaseCapabilityRepositoryError(
        "INVALID_SUPABASE_CAPABILITY_SNAPSHOT",
      );
    }
    return parsed.data;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Capability grant redemption aborted");
  error.name = "AbortError";
  return error;
}
