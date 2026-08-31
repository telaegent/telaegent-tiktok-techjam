import { z } from "zod";
import { isGitHubRepositoryId } from "./github-repository-id.js";
import { SupabaseCapabilityRepositoryError } from "./supabase-capability-repository.js";

/**
 * The seam between a shared conversation and the capability loop.
 *
 * A message that crossed the human gate opens exactly one bounded task, and
 * everything the loop may afterwards do - every grant, every follow-up round -
 * is bounded by it. Scope is derived in the database from the message itself,
 * so nothing here can point a task at a repository the message did not belong
 * to.
 */

const uuidSchema = z.string().uuid();
const githubRepositoryIdSchema = z.string().refine(isGitHubRepositoryId);
const isoTimestampSchema = z.string().datetime({ offset: true });

const openOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.enum(["opened", "existing"]),
    taskId: uuidSchema,
    conversationId: uuidSchema,
    githubRepositoryId: githubRepositoryIdSchema,
    /** Whoever sent the message; the peer whose repository is asked about. */
    requesterUserId: uuidSchema,
    /** Whoever is answering it; the peer whose agent does the asking. */
    responderUserId: uuidSchema,
    expiresAt: isoTimestampSchema,
  }),
  // One answer for a message that does not exist, a conversation that is
  // closed, and a pair of people who are not both in it.
  z.object({ outcome: z.literal("unavailable") }),
]);

const endOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ended"),
    status: z.enum(["completed", "cancelled"]),
  }),
  z.object({ outcome: z.literal("already_ended") }),
  z.object({ outcome: z.literal("unavailable") }),
  z.object({ outcome: z.literal("invalid") }),
]);

export type OpenCollaborationTaskOutcome = z.infer<typeof openOutcomeSchema>;
export type EndCollaborationTaskOutcome = z.infer<typeof endOutcomeSchema>;
export type CollaborationTaskEndStatus = "completed" | "cancelled";

export interface OpenCollaborationTaskInput {
  taskId: string;
  originSharedMessageId: string;
  /** The peer being asked to answer; the sender becomes the requester. */
  responderUserId: string;
}

export interface EndCollaborationTaskInput {
  taskId: string;
  actorUserId: string;
  status: CollaborationTaskEndStatus;
}

export interface CollaborationTaskOptions {
  signal?: AbortSignal | undefined;
}

export interface CollaborationTaskRepository {
  openTask(
    input: Readonly<OpenCollaborationTaskInput>,
    options?: Readonly<CollaborationTaskOptions>,
  ): Promise<OpenCollaborationTaskOutcome>;
  endTask(
    input: Readonly<EndCollaborationTaskInput>,
    options?: Readonly<CollaborationTaskOptions>,
  ): Promise<EndCollaborationTaskOutcome>;
}

export interface SupabaseCollaborationTaskClient {
  openCollaborationTask(
    request: Readonly<OpenCollaborationTaskInput>,
    options?: Readonly<CollaborationTaskOptions>,
  ): Promise<unknown>;
  endCollaborationTask(
    request: Readonly<EndCollaborationTaskInput>,
    options?: Readonly<CollaborationTaskOptions>,
  ): Promise<unknown>;
}

export class SupabaseCollaborationTaskRepository
  implements CollaborationTaskRepository
{
  constructor(private readonly client: SupabaseCollaborationTaskClient) {}

  async openTask(
    input: Readonly<OpenCollaborationTaskInput>,
    options?: Readonly<CollaborationTaskOptions>,
  ): Promise<OpenCollaborationTaskOutcome> {
    return parse(
      openOutcomeSchema,
      await this.#call(
        (signal) => this.client.openCollaborationTask(input, signal),
        options,
      ),
    );
  }

  async endTask(
    input: Readonly<EndCollaborationTaskInput>,
    options?: Readonly<CollaborationTaskOptions>,
  ): Promise<EndCollaborationTaskOutcome> {
    return parse(
      endOutcomeSchema,
      await this.#call(
        (signal) => this.client.endCollaborationTask(input, signal),
        options,
      ),
    );
  }

  async #call(
    invoke: (
      options?: Readonly<CollaborationTaskOptions>,
    ) => Promise<unknown>,
    options?: Readonly<CollaborationTaskOptions>,
  ): Promise<unknown> {
    if (options?.signal?.aborted) throw abortError();
    try {
      return await invoke(options?.signal ? { signal: options.signal } : undefined);
    } catch (error) {
      if (options?.signal?.aborted || isAbortError(error)) throw abortError();
      throw new SupabaseCapabilityRepositoryError(
        "SUPABASE_CAPABILITY_UNAVAILABLE",
      );
    }
  }
}

/**
 * Validation failures never carry their issues outward.
 *
 * A report of what did not parse would describe the row, and the row describes
 * who is talking to whom inside which repository.
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
  const error = new Error("Collaboration task call aborted");
  error.name = "AbortError";
  return error;
}
