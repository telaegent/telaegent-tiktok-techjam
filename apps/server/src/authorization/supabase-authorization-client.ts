import { isGitHubRepositoryId } from "./github-repository-id.js";
import type {
  SupabaseAuthorizationSnapshotClient,
  SupabasePrivateRuntimeAuthorizationRpcRequest,
} from "./supabase-authorization-repository.js";

const rpcPath = "/rest/v1/rpc/load_private_runtime_authorization_snapshot";
const maximumSnapshotResponseBytes = 1_048_576;
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
  implements SupabaseAuthorizationSnapshotClient
{
  readonly #endpoint: string;
  readonly #secretKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: Readonly<SupabaseAuthorizationRpcClientOptions>) {
    const url = validateSupabaseUrl(options.supabaseUrl);
    if (!secretKeyPattern.test(options.secretKey)) {
      throw configurationError();
    }
    this.#endpoint = url.origin + rpcPath;
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

    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        apikey: this.#secretKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        p_user_id: request.authenticatedUserId,
        // Preserve BIGINT precision by keeping the canonical decimal string.
        p_github_repository_id: request.githubRepositoryId,
        p_conversation_id: request.conversationId,
        p_max_project_connections: request.maximumProjectConnections,
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      await discardBody(response);
      throw rpcUnavailableError();
    }

    const text = await readBoundedBody(
      response,
      maximumSnapshotResponseBytes,
    );
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

function validateSupabaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError();
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
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
