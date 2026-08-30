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
import type { IdentityRouteDependencies } from "./authentication/routes.js";

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
}

// The canonical conversation API is what the browser client calls. Leaving it
// out of the composition made every draft and message route answer 404.
const app = await createApp(
  config,
  service,
  telagentService,
  createConversationApi(config),
  identityApi,
);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
