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
import {
  createConnectorResourceBudgetLedger,
  createConnectorGrantRevocationStore,
  createConnectorResourceRegistry,
} from "./connector-local-state.js";
import { acquireConnectorProcessLock } from "./connector-process-lock.js";
import { connectorHttpResponseError } from "./connector-http-error.js";
import { refreshEstablishedReadiness } from "./connector-readiness.js";
import { ConnectorRepositoryRevalidator } from "./connector-repository-revalidator.js";
import { runConnectorProbePump } from "./connector-probe-pump.js";
import {
  probeFailureReason,
  probeFailureSource,
} from "./connector-probe-failure.js";
import {
  confirmRepositorySelection,
  resolveExactRepositoryRoot,
} from "./connector-repository-selection.js";
import {
  connectorProviderCandidates,
  selectConnectorProviders,
} from "./connector-provider-selection.js";

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
const CONTROL_REQUEST_TIMEOUT_MS = 15_000;
const REPOSITORY_PROOF_COMMAND_TIMEOUT_MS = 20_000;

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
  const config = loadConfig({
    ...process.env,
    TELAEGENT_IDENTITY_PROVIDER: "disabled",
    AUTHORIZATION_PERSISTENCE: "memory",
    CONVERSATION_PERSISTENCE: "memory",
    ENABLE_LEGACY_LOCAL_PLAYGROUND: "0",
    CODEX_HOME: process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex"),
  });
  const providerCandidates = connectorProviderCandidates(providerSelection);
  const candidateRunners = [new ClaudeCodeRunner(config), new CodexRunner(config)].filter(
    (runner) => providerCandidates.includes(runner.provider),
  );
  const schemas = new FileOutputSchemaResolver(
    fileURLToPath(new URL("../telagent/output-schemas", import.meta.url)),
  );
  const providerDetector = new RuntimeProviderRegistry(candidateRunners, schemas);
  const selectedProviders = await selectConnectorProviders(
    providerSelection,
    await providerDetector.capabilities(),
  );
  process.stdout.write(
    `TELAEGENT PROVIDER SELECTED (${selectedProviders.join(", ")})\n`,
  );
  const providers = new RuntimeProviderRegistry(
    candidateRunners.filter((runner) => selectedProviders.includes(runner.provider)),
    schemas,
  );

  // Pairing is deliberately exchanged only after the human confirms the exact
  // GitHub repository and selects an available local provider. A wrong folder,
  // origin, provider, or declined prompt therefore cannot consume the
  // single-use browser code or mint a connector bearer.
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
    CONTROL_REQUEST_TIMEOUT_MS,
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
    undefined,
    CONTROL_REQUEST_TIMEOUT_MS,
  );
  const registered = bindingResponseSchema.parse(await response.json()).binding;

  const processLock = await acquireConnectorProcessLock(registered.connectorBindingId);
  try {
    const sessions = new ProviderSessionManager(
      providers,
      new InMemoryProviderSessionStore(),
      async (_scope, request) => request,
    );
    let repositoryRevalidator: ConnectorRepositoryRevalidator | undefined;
    const transport = new HttpConnectorWorkerTransport(
      serverOrigin,
      registered.connectorBindingId,
      credential,
      fetch,
      {
        onRetry: ({ attempt, delayMs }) => {
          process.stderr.write(`TELAEGENT RECONNECTING (attempt ${attempt}, ${delayMs}ms)\n`);
        },
        onRecovered: ({ attempts }) => {
          process.stdout.write(`TELAEGENT RECONNECTED (after ${attempts} attempts)\n`);
          // A meaningful offline interval can outlive the authorization proof.
          // Refresh independently; never hold recovered job polling behind it.
          void repositoryRevalidator?.refresh();
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
          budget: createConnectorResourceBudgetLedger(
            registered.connectorBindingId,
          ),
          revocations: createConnectorGrantRevocationStore(
            registered.connectorBindingId,
          ),
        },
      },
    );

    // Provider children are spawned into their own process group so a cancel
    // can reach the whole tree. That same detachment means Ctrl-C no longer
    // reaches them -- the signal goes to this CLI's group, which the provider
    // is deliberately no longer in -- so quitting the connector would leave a
    // provider CLI running against the owner's repository. Stop them here.
    let stopping = false;
    const stopLocalProviders = (signal: NodeJS.Signals): void => {
      if (stopping) return;
      stopping = true;
      process.stderr.write(`TELAEGENT STOPPING (${signal})
`);
      void providers
        .cancelAll()
        .catch(() => undefined)
        .finally(() => {
          process.exit(0);
        });
    };
    process.once("SIGINT", () => stopLocalProviders("SIGINT"));
    process.once("SIGTERM", () => stopLocalProviders("SIGTERM"));

    let successfulProbes = 0;
    for (const provider of selectedProviders) {
      try {
        // Cancellations and resource requests have priority over jobs in the
        // relay, so keep polling until this provider's bounded cloud probe
        // actually settles. The pump joins both sides on error.
        const probeResult = await runConnectorProbePump(
          (signal) => worker.runOnce(signal),
          (signal) => connectorRequest(
            serverOrigin,
            credential,
            `/api/connectors/bindings/${registered.connectorBindingId}/probe`,
            { provider },
            signal,
          ),
          async (response) => probeResponseSchema.parse(await response.json()),
        );
        if (probeResult.provider !== provider) {
          throw new Error("Connector provider probe returned the wrong provider");
        }
        successfulProbes += 1;
        process.stdout.write(
          `TELAEGENT IS CONNECTED (${probeResult.provider}, ${probeResult.durationMs}ms)\n`,
        );
      } catch (error) {
        // Name the side that actually failed. A stopped long poll says nothing
        // about the provider, and reporting it as the provider's verdict sent
        // developers to debug a CLI that had never been asked to run.
        const label = probeFailureSource(error) === "connector"
          ? "TELAEGENT CONNECTOR POLLING FAILED"
          : "TELAEGENT PROVIDER UNAVAILABLE";
        process.stderr.write(
          `${label} (${provider}): ${probeFailureReason(error)}\n`,
        );
      }
    }
    if (successfulProbes === 0) {
      throw new Error("No local coding provider passed the Telaegent live probe");
    }

    if (probeOnly) {
      process.stdout.write("TELAEGENT LIVE READINESS VERIFIED\n");
      return;
    }

    const refreshRepositoryProof = async (): Promise<void> => {
      const refreshedProof = await collectRepositoryProof(workspacePath);
      assertSameRepositoryScope(proof, refreshedProof);
      const refreshedResponse = await connectorRequest(
        serverOrigin,
        credential,
        "/api/connectors/repository-proofs",
        refreshedProof,
        undefined,
        CONTROL_REQUEST_TIMEOUT_MS,
      );
      const refreshed = bindingResponseSchema.parse(
        await refreshedResponse.json(),
      ).binding;
      if (
        refreshed.connectorBindingId !== registered.connectorBindingId ||
        refreshed.projectId !== registered.projectId ||
        refreshed.githubRepositoryId !== registered.githubRepositoryId
      ) {
        throw new Error("Repository revalidation returned a different binding");
      }
    };
    repositoryRevalidator = new ConnectorRepositoryRevalidator(
      refreshRepositoryProof,
      {
        onRetry: ({ attempt, delayMs }) => {
          process.stderr.write(
            `TELAEGENT REVALIDATING (attempt ${attempt}, ${delayMs}ms)\n`,
          );
        },
        onRecovered: ({ attempts }) => {
          process.stdout.write(
            `TELAEGENT REVALIDATED (after ${attempts} attempts)\n`,
          );
        },
      },
    );

    const announceReady = () => connectorRequest(
      serverOrigin,
      credential,
      `/api/connectors/bindings/${registered.connectorBindingId}/ready`,
      {},
      undefined,
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    await announceReady();
    repositoryRevalidator.start();
    let readinessRefresh: Promise<boolean> | undefined;
    const refreshReadiness = (): Promise<boolean> => {
      if (readinessRefresh) return readinessRefresh;
      const refresh = refreshEstablishedReadiness(announceReady).finally(() => {
        if (readinessRefresh === refresh) readinessRefresh = undefined;
      });
      readinessRefresh = refresh;
      return refresh;
    };
    const heartbeat = setInterval(() => {
      void refreshReadiness();
    }, LIVE_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    try {
      for (;;) {
        await worker.runOnce();
        // Also re-announce after every long-poll cycle so a restarted control
        // plane does not wait for the next heartbeat. This is best-effort after
        // the initial hard readiness gate: the next authenticated job poll will
        // still terminate the connector if its credential has been revoked.
        // Readiness is metadata, while the authenticated long poll is the
        // authoritative connection. Never pause polling behind a slow
        // heartbeat; one bounded single-flight refresh is enough.
        void refreshReadiness();
      }
    } finally {
      clearInterval(heartbeat);
      repositoryRevalidator.stop();
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
  const response = await fetchWithTimeout(
    origin.origin + "/api/connectors/pairings/exchange",
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ pairingCode }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    },
    CONTROL_REQUEST_TIMEOUT_MS,
  );
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

type CollectedRepositoryProof = Awaited<ReturnType<typeof collectRepositoryProof>>;

function assertSameRepositoryScope(
  initial: Readonly<CollectedRepositoryProof>,
  refreshed: Readonly<CollectedRepositoryProof>,
): void {
  if (
    refreshed.github.userId !== initial.github.userId ||
    refreshed.repository.id !== initial.repository.id ||
    refreshed.repository.owner.toLowerCase() !==
      initial.repository.owner.toLowerCase() ||
    refreshed.repository.name.toLowerCase() !== initial.repository.name.toLowerCase()
  ) {
    throw new Error("Local GitHub identity or repository changed; restart the connector");
  }
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
  timeoutMs?: number,
): Promise<Response> {
  const origin = new URL(serverOrigin);
  const response = await fetchWithTimeout(origin.origin + pathname, {
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
  }, timeoutMs, signal);
  if (!response.ok) {
    throw await connectorHttpResponseError(response, "request");
  }
  return response;
}

async function connectorGet(
  serverOrigin: string,
  credential: string,
  pathname: string,
  timeoutMs?: number,
): Promise<Response> {
  const origin = new URL(serverOrigin);
  const response = await fetchWithTimeout(origin.origin + pathname, {
    method: "GET",
    headers: {
      authorization: `Bearer ${credential}`,
      accept: "application/json",
    },
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  }, timeoutMs);
  if (!response.ok) {
    throw await connectorHttpResponseError(response, "GET request");
  }
  return response;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs?: number,
  parentSignal?: AbortSignal,
): Promise<Response> {
  if (timeoutMs === undefined) {
    return await fetch(input, {
      ...init,
      ...(parentSignal ? { signal: parentSignal } : {}),
    });
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error("Connector control request timeout is invalid");
  }
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (!parentSignal?.aborted && controller.signal.aborted) {
      throw new Error("Telaegent control-plane request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

async function run(executable: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(executable, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: REPOSITORY_PROOF_COMMAND_TIMEOUT_MS,
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
