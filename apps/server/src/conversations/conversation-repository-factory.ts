import type { AppConfig } from "../config.js";
import { InMemoryConversationRepository } from "./in-memory-repository.js";
import type { ConversationRepository } from "./repository.js";
import { SupabaseConversationRpcClient } from "./supabase-conversation-client.js";
import { SupabaseConversationRepository } from "./supabase-conversation-repository.js";

export interface ConversationRepositoryFactoryOptions {
  /** Optional adapter supplied by tests and development composition. */
  memoryRepository?: ConversationRepository | undefined;
  /** Test seam; production uses Node's global fetch. */
  fetch?: typeof fetch | undefined;
}

/**
 * Explicit persistence selection for the conversation composition root.
 *
 * Supabase failure never falls back to memory. Approved shared messages are the
 * canonical project memory, so serving an empty in-process transcript after a
 * database outage would present a truthful conversation as if it never
 * happened, and would accept new sends against that missing history.
 */
export function createConfiguredConversationRepository(
  config: Readonly<AppConfig>,
  options: Readonly<ConversationRepositoryFactoryOptions> = {},
): ConversationRepository {
  if (config.conversationPersistence === "memory") {
    return options.memoryRepository ?? new InMemoryConversationRepository();
  }

  const client = new SupabaseConversationRpcClient({
    supabaseUrl: config.supabaseUrl,
    secretKey: config.supabaseSecretKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return new SupabaseConversationRepository(client);
}
