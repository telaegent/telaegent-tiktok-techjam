import { isGitHubRepositoryId } from "./github-repository-id.js";
import { isSafeSupabaseOrigin } from "../supabase-origin.js";
import type {
  SupabaseAuthorizationSnapshotClient,
  SupabasePrivateRuntimeAuthorizationRpcRequest,
} from "./supabase-authorization-repository.js";
import type {
  SupabaseCapabilitySnapshotClient,
  SupabaseCapabilityRouteRpcRequest,
} from "./supabase-capability-repository.js";
import type {
  EndCollaborationTaskInput,
  OpenCollaborationTaskInput,
  SupabaseCollaborationTaskClient,
} from "./collaboration-tasks.js";
import type {
  ConsumeCapabilityGrantInput,
  SupabaseCapabilityGrantClient,
} from "./capability-grants.js";
import type {
  BeginCapabilityFollowUpRoundInput,
  DecideCapabilityScopeRequestInput,
  ListPendingCapabilityScopeRequestsInput,
  RecordCapabilityScopeRequestInput,
  SupabaseCapabilityScopeRequestClient,
} from "./capability-scope-requests.js";

const rpcPath = "/rest/v1/rpc/load_private_runtime_authorization_snapshot";
const capabilityRpcPath =
  "/rest/v1/rpc/load_capability_route_authorization_snapshot";
const scopeRpcPath = "/rest/v1/rpc/";
const maximumSnapshotResponseBytes = 1_048_576;
// A human's approval queue is a list of short sentences, never file content.
const maximumScopeResponseBytes = 262_144;
const maximumHintCharacters = 512;
const maximumReasonCharacters = 2_000;
const resourceIdPattern = /^resource_[A-Za-z0-9_-]{16,120}$/;
const controlCharacterPattern = /\p{Cc}/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const secretKeyPattern = /^sb_secret_[A-Za-z0-9_-]{20,480}$/;

export interface SupabaseAuthorizationRpcClientOptions {
  supabaseUrl: string;
  secretKey: string;
  fetch?: typeof fetch;
}

/**
 * Minimal backend-only PostgREST client for Thai's authorization RPC.
 *
 * It deliberately does not use an Authorization bearer header: modern
 * `sb_secret_...` keys are API keys, not user JWTs. The `apikey` header selects
 * the trusted service role, while browser roles have no execute privilege.
 */
export class SupabaseAuthorizationRpcClient
  implements
    SupabaseAuthorizationSnapshotClient,
    SupabaseCapabilitySnapshotClient,
    SupabaseCapabilityScopeRequestClient,
    SupabaseCapabilityGrantClient,
    SupabaseCollaborationTaskClient
{
  readonly #origin: string;
  readonly #endpoint: string;
  readonly #capabilityEndpoint: string;
  readonly #secretKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: Readonly<SupabaseAuthorizationRpcClientOptions>) {
    const url = validateSupabaseUrl(options.supabaseUrl);
    if (!secretKeyPattern.test(options.secretKey)) {
      throw configurationError();
    }
    this.#origin = url.origin;
    this.#endpoint = url.origin + rpcPath;
    this.#capabilityEndpoint = url.origin + capabilityRpcPath;
    this.#secretKey = options.secretKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw configurationError();
    }
  }

  async fetchPrivateRuntimeAuthorizationSnapshot(
    request: Readonly<SupabasePrivateRuntimeAuthorizationRpcRequest>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown> {
    validateRequest(request);
    return this.#call(this.#endpoint, {
      p_user_id: request.authenticatedUserId,
      // Preserve BIGINT precision by keeping the canonical decimal string.
      p_github_repository_id: request.githubRepositoryId,
      p_conversation_id: request.conversationId,
      p_max_project_connections: request.maximumProjectConnections,
    }, options);
  }

  async fetchCapabilityRouteAuthorizationSnapshot(
    request: Readonly<SupabaseCapabilityRouteRpcRequest>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown> {
    validateCapabilityRequest(request);
    return this.#call(this.#capabilityEndpoint, {
      p_peer_user_id: request.peerUserId,
      p_owner_user_id: request.ownerUserId,
      // Preserve BIGINT precision by keeping the canonical decimal string.
      p_github_repository_id: request.githubRepositoryId,
      p_conversation_id: request.conversationId,
      p_task_id: request.taskId,
      p_grant_id: request.grantId,
    }, options);
  }

  /**
   * Queues one ask on the owning human's approval surface.
   *
   * The candidate identifier is checked here as well as in the database: this
   * process is the last place that could put a path in front of a human, and a
   * path is exactly what a peer would need to make the prompt name a file the
   * owner's connector never resolved.
   */
  async recordCapabilityScopeRequest(
    request: Readonly<RecordCapabilityScopeRequestInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown> {
    if (
      !uuidPattern.test(request.scopeRequestId) ||
      !uuidPattern.test(request.taskId) ||
      !uuidPattern.test(request.ownerUserId) ||
      !uuidPattern.test(request.peerUserId) ||
      request.ownerUserId === request.peerUserId ||
      !resourceIdPattern.test(request.candidateResourceId) ||
      !isPromptText(request.requestedReason, maximumReasonCharacters) ||
      (request.requestedHint !== null &&
        !isPromptText(request.requestedHint, maximumHintCharacters))
    ) {
      throw new Error("Supabase capability scope request is invalid");
    }
    return this.#call(
      this.#scopeEndpoint("record_capability_scope_request"),
      {
        p_scope_request_id: request.scopeRequestId,
        p_task_id: request.taskId,
        p_owner_user_id: request.ownerUserId,
        p_peer_user_id: request.peerUserId,
        p_requested_hint: request.requestedHint,
        p_requested_reason: request.requestedReason,
        p_candidate_resource_id: request.candidateResourceId,
      },
      options,
      maximumScopeResponseBytes,
    );
  }

  async decideCapabilityScopeRequest(
    request: Readonly<DecideCapabilityScopeRequestInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown> {
    if (
      !uuidPattern.test(request.scopeRequestId) ||
      !uuidPattern.test(request.ownerUserId) ||
      !uuidPattern.test(request.grantId) ||
      (request.decision !== "deny" &&
        request.decision !== "once" &&
        request.decision !== "task")
    ) {
      throw new Error("Supabase capability scope decision is invalid");
    }
    return this.#call(
      this.#scopeEndpoint("decide_capability_scope_request"),
      {
        p_scope_request_id: request.scopeRequestId,
        p_owner_user_id: request.ownerUserId,
        p_decision: request.decision,
        p_grant_id: request.grantId,
      },
      options,
      maximumScopeResponseBytes,
    );
  }

  async listPendingCapabilityScopeRequests(
    request: Readonly<ListPendingCapabilityScopeRequestsInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown> {
    if (
      !uuidPattern.test(request.ownerUserId) ||
      !isGitHubRepositoryId(request.githubRepositoryId)
    ) {
      throw new Error("Supabase capability scope listing is invalid");
    }
    return this.#call(
      this.#scopeEndpoint("list_pending_capability_scope_requests"),
      {
        p_owner_user_id: request.ownerUserId,
        // Preserve BIGINT precision by keeping the canonical decimal string.
        p_github_repository_id: request.githubRepositoryId,
      },
      options,
      maximumScopeResponseBytes,
    );
  }

  async beginCapabilityFollowUpRound(
    request: Readonly<BeginCapabilityFollowUpRoundInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown> {
    if (
      !uuidPattern.test(request.taskId) ||
      !uuidPattern.test(request.ownerUserId) ||
      !uuidPattern.test(request.peerUserId) ||
      request.ownerUserId === request.peerUserId
    ) {
      throw new Error("Supabase capability follow-up round is invalid");
    }
    return this.#call(
      this.#scopeEndpoint("begin_capability_follow_up_round"),
      {
        p_task_id: request.taskId,
        p_owner_user_id: request.ownerUserId,
        p_peer_user_id: request.peerUserId,
      },
      options,
      maximumScopeResponseBytes,
    );
  }

  /**
   * Redeems one grant the owning human already delegated.
   *
   * Called after the bytes are already in hand, because the read happened on
   * the owner's machine under its own reference monitor. What this settles is
   * whether the authority survives for a second round.
   */
  async consumeCapabilityGrant(
    request: Readonly<ConsumeCapabilityGrantInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown> {
    if (
      !uuidPattern.test(request.grantId) ||
      !uuidPattern.test(request.ownerUserId) ||
      !uuidPattern.test(request.peerUserId) ||
      request.ownerUserId === request.peerUserId ||
      !resourceIdPattern.test(request.resourceId)
    ) {
      throw new Error("Supabase capability grant redemption is invalid");
    }
    return this.#call(
      this.#scopeEndpoint("consume_capability_grant"),
      {
        p_grant_id: request.grantId,
        p_owner_user_id: request.ownerUserId,
        p_peer_user_id: request.peerUserId,
        p_resource_id: request.resourceId,
      },
      options,
      maximumScopeResponseBytes,
    );
  }

  /**
   * Opens the bounded collaboration one approved message starts.
   *
   * Only the message identifier and the peer being asked are sent. The
   * conversation, project and repository are derived in the database from the
   * message itself, so this call cannot widen a task's scope by asserting one.
   */
  async openCollaborationTask(
    request: Readonly<OpenCollaborationTaskInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown> {
    if (
      !uuidPattern.test(request.taskId) ||
      !uuidPattern.test(request.originSharedMessageId) ||
      !uuidPattern.test(request.responderUserId)
    ) {
      throw new Error("Supabase collaboration task request is invalid");
    }
    return this.#call(
      this.#scopeEndpoint("open_collaboration_task"),
      {
        p_task_id: request.taskId,
        p_origin_shared_message_id: request.originSharedMessageId,
        p_responder_user_id: request.responderUserId,
      },
      options,
      maximumScopeResponseBytes,
    );
  }

  /** Ends a collaboration, retiring every grant made inside it. */
  async endCollaborationTask(
    request: Readonly<EndCollaborationTaskInput>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown> {
    if (
      !uuidPattern.test(request.taskId) ||
      !uuidPattern.test(request.actorUserId) ||
      (request.status !== "completed" && request.status !== "cancelled")
    ) {
      throw new Error("Supabase collaboration task closure is invalid");
    }
    return this.#call(
      this.#scopeEndpoint("end_collaboration_task"),
      {
        p_task_id: request.taskId,
        p_actor_user_id: request.actorUserId,
        p_status: request.status,
      },
      options,
      maximumScopeResponseBytes,
    );
  }

  #scopeEndpoint(functionName: string): string {
    return this.#origin + scopeRpcPath + functionName;
  }

  async #call(
    endpoint: string,
    body: Readonly<Record<string, unknown>>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
    maximumBytes: number = maximumSnapshotResponseBytes,
  ): Promise<unknown> {
    const response = await this.#fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        apikey: this.#secretKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      await discardBody(response);
      throw rpcUnavailableError();
    }

    const text = await readBoundedBody(response, maximumBytes);
    if (text === null) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Return an opaque malformed value so the strict repository mapper
      // classifies a successful-but-invalid RPC payload as an invalid snapshot,
      // rather than exposing response content or misreporting network failure.
      return undefined;
    }
  }
}

/**
 * Text bound for a human's approval prompt.
 *
 * Control characters are refused outright rather than escaped: the prompt
 * states `Permission: READ ONLY` on its own line, and a hint carrying a
 * newline could forge a second line beneath it.
 */
function isPromptText(value: string, maximumCharacters: number): boolean {
  return (
    value.length >= 1 &&
    value.length <= maximumCharacters &&
    !controlCharacterPattern.test(value)
  );
}

function validateCapabilityRequest(
  request: Readonly<SupabaseCapabilityRouteRpcRequest>,
): void {
  if (
    !uuidPattern.test(request.peerUserId) ||
    !uuidPattern.test(request.ownerUserId) ||
    request.peerUserId === request.ownerUserId ||
    !uuidPattern.test(request.conversationId) ||
    !uuidPattern.test(request.taskId) ||
    !uuidPattern.test(request.grantId) ||
    !isGitHubRepositoryId(request.githubRepositoryId)
  ) {
    throw new Error("Supabase capability RPC request is invalid");
  }
}

function validateSupabaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError();
  }
  if (!isSafeSupabaseOrigin(url)) {
    throw configurationError();
  }
  return url;
}

function validateRequest(
  request: Readonly<SupabasePrivateRuntimeAuthorizationRpcRequest>,
): void {
  if (
    !uuidPattern.test(request.authenticatedUserId) ||
    !uuidPattern.test(request.conversationId) ||
    !isGitHubRepositoryId(request.githubRepositoryId) ||
    !Number.isInteger(request.maximumProjectConnections) ||
    request.maximumProjectConnections < 1 ||
    request.maximumProjectConnections > 100
  ) {
    throw new Error("Supabase authorization RPC request is invalid");
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<string | null> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      Number.isFinite(parsedLength) &&
      parsedLength > maximumBytes
    ) {
      await discardBody(response);
      return null;
    }
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The response is invalid regardless of cancellation outcome.
        }
        return null;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Response bodies and transport details are intentionally never surfaced.
  }
}

function configurationError(): Error {
  return new Error("Supabase authorization client configuration is invalid");
}

function rpcUnavailableError(): Error {
  return new Error("Supabase authorization RPC is unavailable");
}
