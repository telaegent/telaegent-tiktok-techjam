import { SupabaseRpcTransport } from "../supabase-rpc-transport.js";
import type {
  ConversationRpcFunction,
  SupabaseConversationClient,
} from "./supabase-conversation-repository.js";

export interface SupabaseConversationRpcClientOptions {
  supabaseUrl: string;
  secretKey: string;
  /** Test seam; production uses Node's global fetch. */
  fetch?: typeof fetch | undefined;
}

/**
 * Backend-only PostgREST client for the canonical conversation RPCs.
 *
 * It holds no conversation knowledge of its own: mapping, validation and
 * lifecycle interpretation belong to `SupabaseConversationRepository`, so this
 * class stays a transport and cannot silently reshape a persisted draft.
 */
export class SupabaseConversationRpcClient implements SupabaseConversationClient {
  readonly #transport: SupabaseRpcTransport;

  constructor(options: Readonly<SupabaseConversationRpcClientOptions>) {
    this.#transport = new SupabaseRpcTransport({
      supabaseUrl: options.supabaseUrl,
      secretKey: options.secretKey,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async callConversationRpc(
    functionName: ConversationRpcFunction,
    params: Readonly<Record<string, unknown>>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown> {
    return this.#transport.call(functionName, params, options);
  }
}
