import { randomUUID } from "node:crypto";
import {
  CapabilityRouteAuthorizationError,
  CapabilityRouteAuthorizationService,
} from "../authorization/capability-route-authorization.js";
import { createConfiguredAuthorizationRepository } from "../authorization/authorization-repository-factory.js";
import type { PrivateRuntimeAuthorizationSnapshot } from "../authorization/repository.js";
import { SupabaseAuthorizationRpcClient } from "../authorization/supabase-authorization-client.js";
import { SupabaseCapabilityRouteAuthorizationRepository } from "../authorization/supabase-capability-repository.js";
import type { AuthorizePrivateRuntimeInput } from "../authorization/types.js";
import { loadConfig } from "../config.js";

const rpcPath = "/rest/v1/rpc/load_private_runtime_authorization_snapshot";
const capabilityRpcPath = "/rest/v1/rpc/load_capability_route_authorization_snapshot";
const maximumProjectConnections = 15;
const requestTimeoutMs = 10_000;

// GitHub repository IDs are positive signed BIGINT decimal strings. The upper
// bound is deliberately used as a non-production sentinel; the random UUIDs
// independently prevent this read from identifying a real user/conversation.
const input: AuthorizePrivateRuntimeInput = {
  authenticatedUserId: randomUUID(),
  githubRepositoryId: "9223372036854775807",
  conversationId: randomUUID(),
};

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (config.authorizationPersistence !== "supabase") {
    throw new Error("Supabase authorization persistence is not enabled");
  }

  const repository = createConfiguredAuthorizationRepository(config);
  const snapshot = await repository.loadPrivateRuntimeAuthorizationSnapshot(
    input,
    {
      maximumProjectConnections,
      signal: AbortSignal.timeout(requestTimeoutMs),
    },
  );
  if (!isCanonicalEmptySnapshot(snapshot)) {
    // Do not interpolate the snapshot: it may contain backend-only paths.
    throw new Error("Live RPC did not return the canonical empty snapshot");
  }

  // Exercise the deployed capability snapshot through the same service-role
  // transport the application uses. Random identities plus the BIGINT sentinel
  // must produce a safe policy denial, never an authorization or row detail.
  const capabilityService = new CapabilityRouteAuthorizationService(
    new SupabaseCapabilityRouteAuthorizationRepository(
      new SupabaseAuthorizationRpcClient({
        supabaseUrl: config.supabaseUrl,
        secretKey: config.supabaseSecretKey,
      }),
    ),
    { repositoryReadTimeoutMs: requestTimeoutMs },
  );
  const peerUserId = randomUUID();
  const ownerUserId = randomUUID();
  const capabilityFailure = await capabilityService.resolveRoute({
    authenticatedUserId: peerUserId,
    ownerUserId,
    githubRepositoryId: input.githubRepositoryId,
    conversationId: randomUUID(),
    taskId: randomUUID(),
  }).catch((error: unknown) => error);
  if (
    !(capabilityFailure instanceof CapabilityRouteAuthorizationError) ||
    capabilityFailure.code !== "CAPABILITY_ROUTE_FORBIDDEN" ||
    capabilityFailure.reason !== "task_unavailable"
  ) {
    throw new Error("Live capability authorization did not fail closed");
  }

  await Promise.all([
    verifyBrowserRoleCannotExecute(config.supabaseUrl, rpcPath, {
      p_user_id: input.authenticatedUserId,
      p_github_repository_id: input.githubRepositoryId,
      p_conversation_id: input.conversationId,
      p_max_project_connections: maximumProjectConnections,
    }),
    verifyBrowserRoleCannotExecute(config.supabaseUrl, capabilityRpcPath, {
      p_peer_user_id: peerUserId,
      p_owner_user_id: ownerUserId,
      p_github_repository_id: input.githubRepositoryId,
      p_conversation_id: randomUUID(),
      p_task_id: randomUUID(),
      p_grant_id: null,
    }),
  ]);

  console.log("Supabase authorization live smoke passed.");
  console.log("- backend-only RPC transport and execute grant: verified");
  console.log("- strict eight-key snapshot contract: verified");
  console.log("- browser publishable role execute denial: verified");
  console.log("- synthetic scope remained fail-closed: verified");
  console.log("- capability routing RPC and fail-closed policy: verified");
}

function isCanonicalEmptySnapshot(
  snapshot: Readonly<PrivateRuntimeAuthorizationSnapshot>,
): boolean {
  return (
    snapshot.user === null &&
    snapshot.githubConnection === null &&
    snapshot.repositoryAccess === null &&
    snapshot.project === null &&
    snapshot.membership === null &&
    snapshot.conversation === null &&
    snapshot.projectConnections.length === 0 &&
    snapshot.runtimeBinding === null
  );
}

async function verifyBrowserRoleCannotExecute(
  supabaseUrl: string,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<void> {
  const publishableKey = (
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    ""
  ).trim();
  if (!/^sb_publishable_[A-Za-z0-9_-]{20,480}$/.test(publishableKey)) {
    throw new Error("A valid Supabase publishable key is required for the ACL smoke");
  }

  const response = await fetch(supabaseUrl + path, {
    method: "POST",
    headers: {
      accept: "application/json",
      apikey: publishableKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  try {
    if (response.ok) {
      throw new Error("Browser publishable role unexpectedly executed the RPC");
    }
    if (![401, 403, 404].includes(response.status)) {
      throw new Error("Browser role ACL check returned an unexpected status");
    }
  } finally {
    try {
      await response.body?.cancel();
    } catch {
      // The status is sufficient; response bodies are intentionally discarded.
    }
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : "Unknown Supabase authorization smoke failure";
  // All lower-layer errors are deliberately value-free. Never print config,
  // request objects, response bodies, snapshot rows, or stack traces here.
  console.error("Supabase authorization live smoke failed: " + message);
  process.exitCode = 1;
});
