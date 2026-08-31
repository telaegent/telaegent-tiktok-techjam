import { z } from "zod";
import { resourceDisplayLabelSchema } from "../connectors/resource-request.js";
import { isGitHubRepositoryId } from "./github-repository-id.js";
import { SupabaseCapabilityRepositoryError } from "./supabase-capability-repository.js";
import type { GitHubRepositoryId } from "./types.js";

/**
 * The queue where a peer's agent waits for a human (build plan 8.1).
 *
 * Everything here is about the gap between asking and getting. A row in this
 * queue is a question, not authority; the only thing that turns it into
 * authority is a person pressing Allow once or Allow for this task, and that
 * still routes through `record_capability_grant`.
 *
 * Nothing in this module ever carries a canonical path or a byte of file
 * content. The cloud routes an opaque identifier and a safe project-relative
 * display label the owner's connector derived from a file it resolved locally.
 */

const uuidSchema = z.string().uuid();
const githubRepositoryIdSchema = z.string().refine(isGitHubRepositoryId);
const isoTimestampSchema = z.string().datetime({ offset: true });

/**
 * Kept byte-for-byte identical to the `capability_scope_requests` check
 * constraint and to the connector's local registry, so an identifier one layer
 * accepts can never be silently rejected by another.
 */
const resourceIdSchema = z.string().regex(/^resource_[A-Za-z0-9_-]{16,120}$/);

/**
 * Text that will be rendered inside a human's approval prompt.
 *
 * Control characters are rejected rather than escaped: the prompt states the
 * permission on its own line, and a hint that could forge a second line could
 * make a read request look like something else. This mirrors the `[[:cntrl:]]`
 * constraint in the migration, so neither layer is load-bearing alone.
 */
const promptTextSchema = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => !/\p{Cc}/u.test(value));

const pendingScopeRequestSchema = z.strictObject({
  scopeRequestId: uuidSchema,
  taskId: uuidSchema,
  conversationId: uuidSchema,
  githubRepositoryId: githubRepositoryIdSchema,
  peerUserId: uuidSchema,
  requestedHint: promptTextSchema(512).nullable(),
  requestedReason: promptTextSchema(2_000),
  // A literal, not an enum: a queued row that ever claimed write or execute
  // authority is malformed, not merely unauthorized.
  operation: z.literal("read"),
  candidateResourceId: resourceIdSchema,
  resourceDisplayLabel: resourceDisplayLabelSchema,
  requestedAt: isoTimestampSchema,
  taskExpiresAt: isoTimestampSchema,
});

const pendingScopeRequestsSchema = z.array(pendingScopeRequestSchema).max(200);

const recordOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("recorded"), scopeRequestId: uuidSchema }),
  z.object({ outcome: z.literal("existing"), scopeRequestId: uuidSchema }),
  z.object({ outcome: z.literal("already_granted"), grantId: uuidSchema }),
  z.object({ outcome: z.literal("task_unavailable") }),
  z.object({ outcome: z.literal("invalid") }),
]);

const decisionOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("approved"),
    grantId: uuidSchema,
    mode: z.enum(["once", "task"]),
  }),
  z.object({ outcome: z.literal("denied") }),
  z.object({ outcome: z.literal("unavailable") }),
  z.object({ outcome: z.literal("task_unavailable") }),
  z.object({ outcome: z.literal("invalid") }),
]);

const roundSchema = z.number().int().min(0).max(5);
const followUpRoundOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("started"), round: roundSchema }),
  z.object({ outcome: z.literal("exhausted"), round: roundSchema }),
  z.object({ outcome: z.literal("task_unavailable") }),
]);

/** One ask waiting on the owning human, safe to render in their browser. */
export type PendingCapabilityScopeRequest = z.infer<
  typeof pendingScopeRequestSchema
> & { githubRepositoryId: GitHubRepositoryId };

export type RecordCapabilityScopeRequestOutcome = z.infer<
  typeof recordOutcomeSchema
>;
export type CapabilityScopeDecisionOutcome = z.infer<
  typeof decisionOutcomeSchema
>;
export type CapabilityFollowUpRoundOutcome = z.infer<
  typeof followUpRoundOutcomeSchema
>;

/** The three buttons, and nothing else. */
export type CapabilityScopeDecision = "deny" | "once" | "task";

export interface RecordCapabilityScopeRequestInput {
  scopeRequestId: string;
  taskId: string;
  ownerUserId: string;
  peerUserId: string;
  /**
   * What the peer's agent said it wanted, verbatim. Null when the peer asked
   * for an identifier it already holds rather than describing a new file.
   */
  requestedHint: string | null;
  requestedReason: string;
  /** Minted on the owner's machine. The cloud can only ever route it. */
  candidateResourceId: string;
  /** Connector-derived project-relative label; never a canonical local path. */
  resourceDisplayLabel: string;
}

export interface DecideCapabilityScopeRequestInput {
  scopeRequestId: string;
  /** Whoever is answering. The row names the only person who may. */
  ownerUserId: string;
  decision: CapabilityScopeDecision;
  /** Pre-allocated so an approval is idempotent under a retried request. */
  grantId: string;
}

export interface ListPendingCapabilityScopeRequestsInput {
  ownerUserId: string;
  /** Repository ID is the scope boundary; repo A never surfaces repo B. */
  githubRepositoryId: GitHubRepositoryId;
}

export interface BeginCapabilityFollowUpRoundInput {
  taskId: string;
  ownerUserId: string;
  peerUserId: string;
}

export interface CapabilityScopeRequestOptions {
  signal?: AbortSignal | undefined;
}

/**
 * Persistence seam for the scope-expansion queue.
 *
 * Implementations must never accept or return a canonical path, file contents,
 * hidden reasoning, or a private draft. They carry a peer's own words, an
 * opaque identifier, and a human's answer.
 */
export interface CapabilityScopeRequestRepository {
  recordScopeRequest(
    input: Readonly<RecordCapabilityScopeRequestInput>,
    options?: Readonly<CapabilityScopeRequestOptions>,
  ): Promise<RecordCapabilityScopeRequestOutcome>;

  decideScopeRequest(
    input: Readonly<DecideCapabilityScopeRequestInput>,
    options?: Readonly<CapabilityScopeRequestOptions>,
  ): Promise<CapabilityScopeDecisionOutcome>;

  listPendingScopeRequests(
    input: Readonly<ListPendingCapabilityScopeRequestsInput>,
    options?: Readonly<CapabilityScopeRequestOptions>,
  ): Promise<readonly PendingCapabilityScopeRequest[]>;

  beginFollowUpRound(
    input: Readonly<BeginCapabilityFollowUpRoundInput>,
    options?: Readonly<CapabilityScopeRequestOptions>,
  ): Promise<CapabilityFollowUpRoundOutcome>;
}

export interface SupabaseCapabilityScopeRequestClient {
  /**
   * Each call reaches exactly one `security invoker` function that only the
   * service role may execute. Implementations must never widen a call into
   * table access: the checks that make asking safe live inside the functions.
   */
  recordCapabilityScopeRequest(
    request: Readonly<RecordCapabilityScopeRequestInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown>;

  decideCapabilityScopeRequest(
    request: Readonly<DecideCapabilityScopeRequestInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown>;

  listPendingCapabilityScopeRequests(
    request: Readonly<ListPendingCapabilityScopeRequestsInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown>;

  beginCapabilityFollowUpRound(
    request: Readonly<BeginCapabilityFollowUpRoundInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown>;
}

/**
 * Supabase-backed scope-expansion queue.
 *
 * Every mapper below is shape-only. Whether an ask may be queued, who may
 * answer it, and whether an answer still fits inside the task remain the
 * database functions' decisions, so a transport change can never quietly
 * become a policy change.
 */
export class SupabaseCapabilityScopeRequestRepository
  implements CapabilityScopeRequestRepository
{
  constructor(private readonly client: SupabaseCapabilityScopeRequestClient) {}

  async recordScopeRequest(
    input: Readonly<RecordCapabilityScopeRequestInput>,
    options?: Readonly<CapabilityScopeRequestOptions>,
  ): Promise<RecordCapabilityScopeRequestOutcome> {
    return parse(
      recordOutcomeSchema,
      await this.#call(
        (signal) => this.client.recordCapabilityScopeRequest(input, signal),
        options,
      ),
    );
  }

  async decideScopeRequest(
    input: Readonly<DecideCapabilityScopeRequestInput>,
    options?: Readonly<CapabilityScopeRequestOptions>,
  ): Promise<CapabilityScopeDecisionOutcome> {
    return parse(
      decisionOutcomeSchema,
      await this.#call(
        (signal) => this.client.decideCapabilityScopeRequest(input, signal),
        options,
      ),
    );
  }

  async listPendingScopeRequests(
    input: Readonly<ListPendingCapabilityScopeRequestsInput>,
    options?: Readonly<CapabilityScopeRequestOptions>,
  ): Promise<readonly PendingCapabilityScopeRequest[]> {
    return parse(
      pendingScopeRequestsSchema,
      await this.#call(
        (signal) => this.client.listPendingCapabilityScopeRequests(input, signal),
        options,
      ),
    ) as readonly PendingCapabilityScopeRequest[];
  }

  async beginFollowUpRound(
    input: Readonly<BeginCapabilityFollowUpRoundInput>,
    options?: Readonly<CapabilityScopeRequestOptions>,
  ): Promise<CapabilityFollowUpRoundOutcome> {
    return parse(
      followUpRoundOutcomeSchema,
      await this.#call(
        (signal) => this.client.beginCapabilityFollowUpRound(input, signal),
        options,
      ),
    );
  }

  async #call(
    invoke: (
      options?: Readonly<{ signal?: AbortSignal | undefined }>,
    ) => Promise<unknown>,
    options?: Readonly<CapabilityScopeRequestOptions>,
  ): Promise<unknown> {
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
    return payload;
  }
}

function parse<Schema extends z.ZodTypeAny>(
  schema: Schema,
  payload: unknown,
): z.infer<Schema> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // Never the issues: a validation report of a queue row would describe the
    // peer's own words back to whoever triggered the failure.
    throw new SupabaseCapabilityRepositoryError(
      "INVALID_SUPABASE_CAPABILITY_SNAPSHOT",
    );
  }
  return parsed.data;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Capability scope request aborted");
  error.name = "AbortError";
  return error;
}
