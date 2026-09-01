#!/usr/bin/env node

import { execFile } from "node:child_process";
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
import { acquireConnectorProcessLock } from "./connector-process-lock.js";
import { connectorHttpResponseError } from "./connector-http-error.js";
import { refreshEstablishedReadiness } from "./connector-readiness.js";
import { runConnectorProbePump } from "./connector-probe-pump.js";
import {
  confirmRepositorySelection,
  resolveExactRepositoryRoot,
} from "./connector-repository-selection.js";

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
const pairingResponseSchema = z.strictObject({
  connector: z.strictObject({
    credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    connectorInstanceId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
    expiresAt: z.string().datetime({ offset: true }),
  }),
});
const LIVE_HEARTBEAT_INTERVAL_MS = 20_000;

async function main(): Promise<void> {
  const options = parseConnectorCliOptions(process.argv.slice(2));
  const {
    workspaceCandidate,
    provider: providerSelection,
    probeOnly,
  } = options;
  const serverOrigin = validateServerOrigin(
    options.serverOrigin ?? requiredEnvironment("TELAEGENT_URL"),
  );
  const workspacePath = await resolveExactRepositoryRoot(workspaceCandidate);
  const proof = await collectRepositoryProof(workspacePath);
  await confirmRepositorySelection(
    `${proof.repository.owner}/${proof.repository.name}`,
    workspacePath,
  );
  // Pairing is deliberately exchanged only after the human confirms the exact
  // GitHub repository. A wrong folder, origin, or declined prompt therefore
  // cannot consume the single-use browser code or mint a connector bearer.
  const bootstrap = options.pairingCode
    ? await exchangePairing(serverOrigin, options.pairingCode)
    : {
        credential:
          options.credential ?? requiredEnvironment("TELAEGENT_CONNECTOR_CREDENTIAL"),
        connectorInstanceId:
          options.connectorInstanceId ??
          requiredEnvironment("TELAEGENT_CONNECTOR_INSTANCE_ID"),
      };
  const { credential, connectorInstanceId } = bootstrap;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(connectorInstanceId)) {
    throw new Error("TELAEGENT_CONNECTOR_INSTANCE_ID is invalid");
  }

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
  const response = await connectorRequest(
    serverOrigin,
    credential,
    "/api/connectors/repository-proofs",
    proof,
  );
  const registered = bindingResponseSchema.parse(await response.json()).binding;

  const processLock = await acquireConnectorProcessLock(registered.connectorBindingId);
  try {
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
        onRuntimeFailure: ({ provider, code, errorName, phase, exitCode }) => {
          process.stderr.write(
            `TELAEGENT TURN FAILED (${provider}, ${code}, phase=${phase}, ` +
              `exit=${exitCode ?? "none"}, ${errorName})\n`,
          );
        },
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
      try {
        // Cancellations and resource requests have priority over jobs in the
        // relay, so keep polling until this provider's bounded cloud probe
        // actually settles. The shared signal also joins both sides on error.
        const probeResponse = await runConnectorProbePump(
          (signal) => worker.runOnce(signal),
          (signal) => connectorRequest(
            serverOrigin,
            credential,
            `/api/connectors/bindings/${registered.connectorBindingId}/probe`,
            { provider },
            signal,
          ),
        );
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

    if (probeOnly) {
      process.stdout.write("TELAEGENT LIVE READINESS VERIFIED\n");
      return;
    }

    const announceReady = () => connectorRequest(
      serverOrigin,
      credential,
      `/api/connectors/bindings/${registered.connectorBindingId}/ready`,
      {},
    );
    await announceReady();
    let heartbeatInFlight = false;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void announceReady()
        .catch(() => undefined)
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, LIVE_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    try {
      for (;;) {
        await worker.runOnce();
        // Also re-announce after every long-poll cycle so a restarted control
        // plane does not wait for the next heartbeat. This is best-effort after
        // the initial hard readiness gate: the next authenticated job poll will
        // still terminate the connector if its credential has been revoked.
        await refreshEstablishedReadiness(announceReady);
      }
    } finally {
      clearInterval(heartbeat);
    }
  } finally {
    await processLock.release();
  }
}

async function exchangePairing(
  serverOrigin: string,
  pairingCode: string,
): Promise<{ credential: string; connectorInstanceId: string }> {
  const origin = new URL(serverOrigin);
  const response = await fetch(origin.origin + "/api/connectors/pairings/exchange", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ pairingCode }),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Telaegent connector pairing failed; create a new command in the website");
  }
  return pairingResponseSchema.parse(await response.json()).connector;
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
  signal?: AbortSignal,
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
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw await connectorHttpResponseError(response, "request");
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
    throw await connectorHttpResponseError(response, "GET request");
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
