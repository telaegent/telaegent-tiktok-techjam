import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { isArkConfigured, loadConfig, writeCodexConfig } from "./config.js";
import { createConversationApi } from "./conversations/conversation-api-factory.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import {
  RuntimeUnavailableConflictEvaluator,
  RuntimeUnavailableConversationOrchestrator,
} from "./telagent/conversation-orchestrator.js";
import { TelagentService } from "./telagent/service.js";
import { GitHubOAuthClient } from "./authentication/github-oauth-client.js";
import { TelaegentIdentityService } from "./authentication/identity-service.js";
import { SupabaseIdentityRepository } from "./authentication/supabase-identity-repository.js";
import {
  createAuthenticatedUserResolver,
  type IdentityRouteDependencies,
} from "./authentication/routes.js";
import {
  ConnectorCredentialService,
  SupabaseConnectorCredentialRepository,
  createConnectorPrincipalResolver,
} from "./connectors/connector-credentials.js";
import { ConnectorPairingService } from "./connectors/connector-pairing.js";
import { LongPollConnectorJobRelay } from "./connectors/long-poll-job-relay.js";
import type { ConnectorTransportRouteDependencies } from "./connectors/routes.js";
import type { RepositoryProofRouteDependencies } from "./repository-proof/routes.js";
import { RepositoryProofService } from "./repository-proof/service.js";
import { SupabaseRepositoryProofRepository } from "./repository-proof/supabase-repository.js";
import { createConfiguredAuthorizationRepository } from "./authorization/authorization-repository-factory.js";
import { PrivateRuntimeAuthorizationService } from "./authorization/private-runtime-authorization.js";
import { createConfiguredConversationRepository } from "./conversations/conversation-repository-factory.js";
import type { ConversationApiFactoryOptions } from "./conversations/conversation-api-factory.js";
import { AuthorizedProtocolDraftRuntime } from "./conversations/authorized-runtime-adapter.js";
import { SupabaseProtocolContextLoader } from "./conversations/supabase-protocol-context-loader.js";
import { createAuthorizedProtocolTurnRuntime } from "./telagent/protocol/authorized-turn-service.js";
import type { ProjectRouteDependencies } from "./projects/routes.js";
import { ProjectService } from "./projects/service.js";
import { SupabaseProjectRepository } from "./projects/supabase-repository.js";
import type { CapabilityScopeRouteDependencies } from "./capability/routes.js";
import { CapabilityScopeExpansionService } from "./capability/service.js";
import { createPrivateDraftFollowUp } from "./capability/follow-up-factory.js";
import { SupabaseCapabilityScopeRequestRepository } from "./authorization/capability-scope-requests.js";
import { SupabaseAuthorizationRpcClient } from "./authorization/supabase-authorization-client.js";

const config = loadConfig();
// Preserve the inherited Starter Kit only when its legacy Ark credentials are
// deliberately supplied. Canonical Telaegent runtimes keep their own Codex
// authentication state and must not have CODEX_HOME overwritten at startup.
if (isArkConfigured(config)) {
  await writeCodexConfig(config);
}

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
// The data directory must exist before anything mutates the store. Legacy
// Playground startup used to be the only caller, so the canonical control
// plane crashed on its first write once the Playground stopped being mounted.
await store.initialize();
// The inherited Playground can still be enabled for local legacy maintenance,
// but the cloud server must never construct a provider runner or workspace.
// Canonical provider execution belongs to the outbound local connector.
let service: AgentService | undefined;
if (config.enableLegacyLocalPlayground) {
  const workspaces = new WorkspaceManager(config.workspaceRoot);
  const runner = createRunner(config);
  service = new AgentService(config, store, workspaces, runner);
  await service.initialize();
}
const telagentService = new TelagentService(
  store,
  new RuntimeUnavailableConversationOrchestrator(),
  new RuntimeUnavailableConflictEvaluator(),
);
await telagentService.reconcileOnStartup();

let identityApi: IdentityRouteDependencies | undefined;
let connectorTransportApi: ConnectorTransportRouteDependencies | undefined;
let repositoryProofApi: RepositoryProofRouteDependencies | undefined;
let projectApi: ProjectRouteDependencies | undefined;
let capabilityScopeApi: CapabilityScopeRouteDependencies | undefined;
// The human gate and the loop that queues into it are composed apart but
// share one instance: a request the loop raises has to land in the same
// queue the owner is answering from.
let capabilityScope: CapabilityScopeExpansionService | undefined;
let authorizationRpc: SupabaseAuthorizationRpcClient | undefined;
const conversationOptions: ConversationApiFactoryOptions = {};
if (config.telaegentIdentityProvider === "github") {
  const secureCookies = config.telaegentPublicOrigin.startsWith("https://");
  const identityRepository = new SupabaseIdentityRepository(
    config.supabaseUrl,
    config.supabaseSecretKey,
    config.githubOAuthTimeoutMs,
  );
  const github = new GitHubOAuthClient(
    config.githubOAuthClientId,
    config.githubOAuthClientSecret,
    config.telaegentPublicOrigin + "/api/auth/github/callback",
    config.githubOAuthTimeoutMs,
  );
  const identityService = new TelaegentIdentityService(
    identityRepository,
    github,
    Buffer.from(config.telaegentCookieSecret, "base64url"),
    config.telaegentSessionTtlSeconds,
  );
  identityApi = {
    service: identityService,
    publicOrigin: config.telaegentPublicOrigin,
    secureCookies,
  };
  const authenticatedUserId = createAuthenticatedUserResolver(
    identityService,
    secureCookies,
    config.telaegentPublicOrigin,
  );
  conversationOptions.authenticatedUserId = authenticatedUserId;
  const credentialService = new ConnectorCredentialService(
    new SupabaseConnectorCredentialRepository(
      config.supabaseUrl,
      config.supabaseSecretKey,
      config.githubOAuthTimeoutMs,
    ),
    config.connectorCredentialTtlSeconds,
  );
  const resolveConnectorPrincipal = createConnectorPrincipalResolver(
    credentialService,
  );
  const relay = new LongPollConnectorJobRelay({
    jobTimeoutMs: Math.max(config.claudeTimeoutMs, config.codexTimeoutMs),
  });
  connectorTransportApi = {
    relay,
    resolveConnectorPrincipal,
    credentials: credentialService,
    pairings: new ConnectorPairingService(),
    authenticatedUserId,
  };
  repositoryProofApi = {
    service: new RepositoryProofService(
      new SupabaseRepositoryProofRepository(
        config.supabaseUrl,
        config.supabaseSecretKey,
        config.githubOAuthTimeoutMs,
      ),
    ),
    resolveConnectorPrincipal,
    onBindingRegistered: (principal, connectorBindingId, githubRepositoryId) => {
      relay.registerBinding(principal, connectorBindingId, githubRepositoryId);
    },
    onBindingUnavailable: async (principal, githubRepositoryId) => {
      await relay.unregisterRepositoryBinding(principal, githubRepositoryId);
    },
  };
  // The human gate on the capability loop. It shares the authorization RPC
  // client because the queue and the grants it creates are the same trust
  // boundary, reached through the same service-role key.
  if (config.authorizationPersistence === "supabase") {
    authorizationRpc = new SupabaseAuthorizationRpcClient({
      supabaseUrl: config.supabaseUrl,
      secretKey: config.supabaseSecretKey,
    });
    capabilityScope = new CapabilityScopeExpansionService({
      repository: new SupabaseCapabilityScopeRequestRepository(authorizationRpc),
    });
    capabilityScopeApi = { service: capabilityScope, authenticatedUserId };
  }

  projectApi = {
    service: new ProjectService(
      new SupabaseProjectRepository(
        config.supabaseUrl,
        config.supabaseSecretKey,
        config.githubOAuthTimeoutMs,
      ),
    ),
    authenticatedUserId,
    isBindingOnline: (userId, connectorBindingId) =>
      relay.isBindingOnline(userId, connectorBindingId),
    onRepositoryDisconnected: async (userId, githubRepositoryId) => {
      await relay.unregisterUserRepositoryBindings(userId, githubRepositoryId);
    },
  };

  if (
    config.authorizationPersistence === "supabase" &&
    config.conversationPersistence === "supabase"
  ) {
    const authorizationRepository = createConfiguredAuthorizationRepository(config);
    const authorizer = new PrivateRuntimeAuthorizationService(
      authorizationRepository,
      { repositoryAccessMaxAgeMs: 900_000, repositoryReadTimeoutMs: 5_000 },
    );
    const conversationRepository = createConfiguredConversationRepository(config);
    const contextLoader = new SupabaseProtocolContextLoader(
      config.supabaseUrl,
      config.supabaseSecretKey,
    );
    const protocolRuntime = createAuthorizedProtocolTurnRuntime({
      authorizer,
      loadContext: contextLoader.load,
      connector: relay,
      policy: {
        maxTurns: 2,
        maximumRuntimePromptBytes: 1_048_576,
        maximumPersistedSummaryBytes: 524_288,
      },
    });
    conversationOptions.repository = conversationRepository;
    conversationOptions.authorizer = authorizer;
    conversationOptions.runtime = new AuthorizedProtocolDraftRuntime(
      protocolRuntime.turns,
      protocolRuntime.coordinator,
    );
    // The capability loop. A recipient turn that asks for files on the other
    // person's machine now has somewhere to send the question; without this it
    // answered without them. It is composed only alongside the connector
    // runtime, because a round it could not route would spend itself for
    // nothing.
    if (capabilityScope && authorizationRpc) {
      conversationOptions.followUp = createPrivateDraftFollowUp({
        authorization: authorizationRpc,
        relay,
        scope: capabilityScope,
      });
    }
  }
}

// The canonical conversation API is what the browser client calls. Leaving it
// out of the composition made every draft and message route answer 404.
const app = await createApp(
  config,
  service,
  telagentService,
  createConversationApi(config, conversationOptions),
  identityApi,
  repositoryProofApi,
  connectorTransportApi,
  projectApi,
  capabilityScopeApi,
);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
