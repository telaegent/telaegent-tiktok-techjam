import type { AppConfig } from "../config.js";
import {
  InMemoryPrivateRuntimeAuthorizationRepository,
  type InMemoryPrivateRuntimeAuthorizationData,
} from "./in-memory-authorization-repository.js";
import type { PrivateRuntimeAuthorizationRepository } from "./repository.js";
import { SupabaseAuthorizationRpcClient } from "./supabase-authorization-client.js";
import { SupabasePrivateRuntimeAuthorizationRepository } from "./supabase-authorization-repository.js";

const emptyAuthorizationData: InMemoryPrivateRuntimeAuthorizationData = {
  users: [],
  githubConnections: [],
  repositoryAccesses: [],
  projects: [],
  memberships: [],
  conversations: [],
  projectConnections: [],
  runtimeBindings: [],
};

export interface AuthorizationRepositoryFactoryOptions {
  /** Optional mutable local adapter used by development/demo composition. */
  memoryRepository?: PrivateRuntimeAuthorizationRepository | undefined;
  /** Test seam; production uses Node's global fetch. */
  fetch?: typeof fetch | undefined;
}

/**
 * Explicit persistence selection for the production composition root.
 *
 * Supabase failure never falls back to memory: doing so could resurrect stale
 * authorization facts after a revocation. The default empty memory repository
 * is intentionally fail-closed until trusted local fixtures are supplied.
 */
export function createConfiguredAuthorizationRepository(
  config: Readonly<AppConfig>,
  options: Readonly<AuthorizationRepositoryFactoryOptions> = {},
): PrivateRuntimeAuthorizationRepository {
  if (config.authorizationPersistence === "memory") {
    return (
      options.memoryRepository ??
      new InMemoryPrivateRuntimeAuthorizationRepository(emptyAuthorizationData)
    );
  }

  const client = new SupabaseAuthorizationRpcClient({
    supabaseUrl: config.supabaseUrl,
    secretKey: config.supabaseSecretKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return new SupabasePrivateRuntimeAuthorizationRepository(client);
}
