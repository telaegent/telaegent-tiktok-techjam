import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { ClaudeCodeRunner } from "../claude-code-runner.js";
import { CodexRunner } from "../codex-runner.js";
import {
  InMemoryProviderSessionStore,
  ProviderSessionManager,
} from "../provider-session-manager.js";
import {
  FileOutputSchemaResolver,
  RuntimeProviderRegistry,
} from "../runtime-provider-registry.js";
import { repositoryProofResultSchema } from "../repository-proof/contract.js";
import { connectorPrincipalSchema } from "../repository-proof/contract.js";
import { ConnectorWorker, HttpConnectorWorkerTransport } from "./connector-worker.js";
import { parseConnectorCliOptions } from "./connector-cli-options.js";
import { createConnectorResourceRegistry } from "./connector-local-state.js";

const execFileAsync = promisify(execFile);
const githubUserSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/),
  login: z.string().min(1).max(39),
});
const githubRepositorySchema = z.object({
  id: z.string().regex(/^[1-9][0-9]*$/),
  name: z.string().min(1).max(100),
  owner: z.object({ login: z.string().min(1).max(39) }),
  visibility: z.enum(["public", "private", "internal"]),
  default_branch: z.string().min(1).max(255),
  permissions: z.object({
    pull: z.boolean().optional(),
    triage: z.boolean().optional(),
    push: z.boolean().optional(),
    maintain: z.boolean().optional(),
    admin: z.boolean().optional(),
  }),
});
const bindingResponseSchema = z.strictObject({ binding: repositoryProofResultSchema });
const probeResponseSchema = z.strictObject({
  connected: z.literal(true),
  provider: z.enum(["codex", "claude"]),
  durationMs: z.number().nonnegative(),
});

async function main(): Promise<void> {
  const { workspaceCandidate, provider: providerSelection } =
    parseConnectorCliOptions(process.argv.slice(2));
  const serverOrigin = validateServerOrigin(requiredEnvironment("TELAEGENT_URL"));
  const credential = requiredEnvironment("TELAEGENT_CONNECTOR_CREDENTIAL");
  const connectorInstanceId = requiredEnvironment("TELAEGENT_CONNECTOR_INSTANCE_ID");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(connectorInstanceId)) {
    throw new Error("TELAEGENT_CONNECTOR_INSTANCE_ID is invalid");
  }

  const workspacePath = await resolveRepositoryRoot(workspaceCandidate);
  const principalResponse = await connectorGet(
    serverOrigin,
    credential,
    "/api/connectors/session",
  );
  const principal = z.strictObject({ connector: connectorPrincipalSchema }).parse(
    await principalResponse.json(),
  ).connector;
  if (principal.connectorInstanceId !== connectorInstanceId) {
    throw new Error("Connector credential belongs to another installation");
  }
  const proof = await collectRepositoryProof(workspacePath);
  const response = await connectorRequest(
    serverOrigin,
    credential,
    "/api/connectors/repository-proofs",
    proof,
  );
  const registered = bindingResponseSchema.parse(await response.json()).binding;

  const config = loadConfig({
    ...process.env,
    TELAEGENT_IDENTITY_PROVIDER: "disabled",
    AUTHORIZATION_PERSISTENCE: "memory",
    CONVERSATION_PERSISTENCE: "memory",
    ENABLE_LEGACY_LOCAL_PLAYGROUND: "0",
    CODEX_HOME: process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex"),
  });
  const localRunners = [new ClaudeCodeRunner(config), new CodexRunner(config)].filter(
    (runner) => providerSelection === "auto" || runner.provider === providerSelection,
  );
  const providers = new RuntimeProviderRegistry(
    localRunners,
    new FileOutputSchemaResolver(
      fileURLToPath(new URL("../telagent/output-schemas", import.meta.url)),
    ),
  );
  const sessions = new ProviderSessionManager(
    providers,
    new InMemoryProviderSessionStore(),
    async (_scope, request) => request,
  );
  const transport = new HttpConnectorWorkerTransport(
    serverOrigin,
    registered.connectorBindingId,
    credential,
    fetch,
    {
      onRetry: ({ attempt, delayMs }) => {
        process.stderr.write(`TELAEGENT RECONNECTING (attempt ${attempt}, ${delayMs}ms)\n`);
      },
    },
  );
  const worker = new ConnectorWorker(
    {
      connectorBindingId: registered.connectorBindingId,
      authenticatedUserId: principal.authenticatedUserId,
      githubRepositoryId: registered.githubRepositoryId,
      workspacePath,
    },
    sessions,
    transport,
    {
      cancel: (bindingId) => providers.cancel(bindingId),
      resources: {
        registry: createConnectorResourceRegistry(registered.connectorBindingId),
      },
    },
  );

  const capabilities = await providers.capabilities();
  const selectedProviders = providerSelection === "auto"
    ? (["claude", "codex"] as const)
    : ([providerSelection] as const);
  const availableProviders = selectedProviders.filter(
    (provider) => capabilities[provider].authenticated,
  );
  if (availableProviders.length === 0) {
    throw new Error(
      "No authenticated Claude Code or Codex CLI is available; sign in locally and retry",
    );
  }

  let successfulProbes = 0;
  for (const provider of availableProviders) {
    // Pair one bounded cloud probe with one connector poll. The provider is a
    // local capability selected by this authenticated connector, never an
    // executable or command supplied by the browser or a collaborator.
    const firstJob = worker.runOnce();
    const probe = connectorRequest(
      serverOrigin,
      credential,
      `/api/connectors/bindings/${registered.connectorBindingId}/probe`,
      { provider },
    );
    try {
      const [probeResponse] = await Promise.all([probe, firstJob]);
      const probeResult = probeResponseSchema.parse(await probeResponse.json());
      if (probeResult.provider !== provider) {
        throw new Error("Connector provider probe returned the wrong provider");
      }
      successfulProbes += 1;
      process.stdout.write(
        `TELAEGENT IS CONNECTED (${probeResult.provider}, ${probeResult.durationMs}ms)\n`,
      );
    } catch {
      process.stderr.write(`TELAEGENT PROVIDER UNAVAILABLE (${provider})\n`);
    }
  }
  if (successfulProbes === 0) {
    throw new Error("No local coding provider passed the Telaegent live probe");
  }

  for (;;) await worker.runOnce();
}

async function resolveRepositoryRoot(candidate: string): Promise<string> {
  const selected = await realpath(path.resolve(candidate));
  const root = (await run("git", ["-C", selected, "rev-parse", "--show-toplevel"])).trim();
  return await realpath(root);
}

async function collectRepositoryProof(workspacePath: string) {
  const remote = (await run("git", [
    "-C",
    workspacePath,
    "config",
    "--get",
    "remote.origin.url",
  ])).trim();
  const repositoryName = parseGitHubRemote(remote);
  const [userRaw, repositoryRaw, commitSha, currentBranchRaw] = await Promise.all([
    run("gh", ["api", "user", "--jq", "{id:(.id|tostring),login}"]),
    run("gh", [
      "api",
      `repos/${repositoryName}`,
      "--jq",
      "{id:(.id|tostring),name,owner:{login:.owner.login},visibility,default_branch,permissions}",
    ]),
    run("git", ["-C", workspacePath, "rev-parse", "HEAD"]),
    runAllowingExitOne("git", ["-C", workspacePath, "symbolic-ref", "--short", "-q", "HEAD"]),
  ]);
  const user = githubUserSchema.parse(JSON.parse(userRaw));
  const repository = githubRepositorySchema.parse(JSON.parse(repositoryRaw));
  return {
    version: 1 as const,
    proofId: randomUUID(),
    observedAt: new Date().toISOString(),
    github: { userId: String(user.id), login: user.login },
    repository: {
      id: String(repository.id),
      owner: repository.owner.login,
      name: repository.name,
      visibility: repository.visibility,
      defaultBranch: repository.default_branch,
      currentBranch: currentBranchRaw.trim() || null,
      commitSha: commitSha.trim().toLowerCase(),
      permission: repositoryPermission(repository.permissions),
    },
  };
}

function parseGitHubRemote(remote: string): string {
  const match = remote.match(
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/,
  );
  if (!match) throw new Error("origin is not a supported GitHub repository remote");
  return match[1]!;
}

function repositoryPermission(permissions: z.infer<typeof githubRepositorySchema>["permissions"]) {
  if (permissions.admin) return "admin" as const;
  if (permissions.maintain) return "maintain" as const;
  if (permissions.push) return "write" as const;
  if (permissions.triage) return "triage" as const;
  if (permissions.pull) return "read" as const;
  throw new Error("GitHub repository permission is unavailable");
}

async function connectorRequest(
  serverOrigin: string,
  credential: string,
  pathname: string,
  body: unknown,
): Promise<Response> {
  const origin = new URL(serverOrigin);
  const response = await fetch(origin.origin + pathname, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Telaegent connector request failed");
  }
  return response;
}

async function connectorGet(
  serverOrigin: string,
  credential: string,
  pathname: string,
): Promise<Response> {
  const origin = new URL(serverOrigin);
  const response = await fetch(origin.origin + pathname, {
    method: "GET",
    headers: {
      authorization: `Bearer ${credential}`,
      accept: "application/json",
    },
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Telaegent connector request failed");
  }
  return response;
}

async function run(executable: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(executable, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function runAllowingExitOne(executable: string, args: string[]): Promise<string> {
  try {
    return await run(executable, args);
  } catch (error) {
    const candidate = error as { code?: unknown; stdout?: unknown };
    if (candidate.code === 1 && typeof candidate.stdout === "string") return candidate.stdout;
    throw error;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateServerOrigin(value: string): string {
  const url = new URL(value);
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("TELAEGENT_URL must be HTTPS (or loopback HTTP) with no path");
  }
  return url.origin;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Connector failed";
  process.stderr.write(message + "\n");
  process.exitCode = 1;
});
