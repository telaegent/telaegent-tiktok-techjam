import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { ClaudeCodeRunner } from "../claude-code-runner.js";
import { CodexRunner } from "../codex-runner.js";
import { loadConfig } from "../config.js";
import {
  InMemoryProviderSessionStore,
  ProviderSessionManager,
  type ManagedAgentTurnRequest,
  type ProviderSessionScope,
} from "../provider-session-manager.js";
import type {
  AgentProvider,
  JsonSchemaDocument,
  MiddlewareProviderRunner,
  MiddlewareRunRequest,
  RuntimeProgressEvent,
  RuntimeProgressSink,
} from "../runtime-contract.js";
import { RuntimeProviderError } from "../runtime-errors.js";

const recoverySchema: JsonSchemaDocument = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 1, maxLength: 200 },
    contextRecovered: { type: "boolean" },
  },
  required: ["message", "contextRecovered"],
  additionalProperties: false,
};

interface RecoveryResult {
  message: string;
  contextRecovered: boolean;
}

function selectedProvider(): AgentProvider {
  const value = process.env.TELAEGENT_RECOVERY_PROVIDER?.trim().toLowerCase();
  if (!value || value === "codex") return "codex";
  if (value === "claude") return "claude";
  throw new Error(
    "TELAEGENT_RECOVERY_PROVIDER must be either codex or claude",
  );
}

function progressPrinter(event: RuntimeProgressEvent): void {
  if (event.type === "text_delta") return;
  if (event.type === "activity_started" || event.type === "activity_completed") {
    console.log(`[runtime] ${event.type}: ${event.activity}`);
    return;
  }
  console.log(`[runtime] ${event.type}`);
}

function assertRecoveryResult(value: unknown): asserts value is RecoveryResult {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).message !== "string" ||
    (value as Record<string, unknown>).contextRecovered !== true
  ) {
    throw new Error("Provider did not confirm the injected recovery context");
  }
}

const provider = selectedProvider();
const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const config = loadConfig({
  ...process.env,
  NODE_ENV: "development",
  CODEX_HOME: codexHome,
});
const runner: MiddlewareProviderRunner =
  provider === "codex" ? new CodexRunner(config) : new ClaudeCodeRunner(config);
const capability = await runner.capability();

if (!capability.installed || !capability.authenticated) {
  throw new Error(
    `${provider === "codex" ? "Codex" : "Claude Code"} is not connected`,
  );
}

const workspacePath = await mkdtemp(
  path.join(tmpdir(), `telaegent-${provider}-recovery-`),
);
const scope: ProviderSessionScope = {
  userId: "recovery-demo-user",
  githubRepositoryId: 1,
  conversationId: "recovery-demo-conversation",
  provider,
};
const invalidSessionId = randomUUID();
const sessions = new InMemoryProviderSessionStore();
await sessions.set({
  ...scope,
  sessionId: invalidSessionId,
  updatedAt: new Date(0).toISOString(),
});

const attemptModes: MiddlewareRunRequest["sessionMode"][] = [];
const failureCodes: string[] = [];
let hydrationCount = 0;

const runtime = {
  async run(request: MiddlewareRunRequest, onProgress?: RuntimeProgressSink) {
    attemptModes.push(request.sessionMode);
    try {
      return await runner.runStructured(request, recoverySchema, onProgress);
    } catch (error) {
      if (error instanceof RuntimeProviderError) failureCodes.push(error.code);
      throw error;
    }
  },
};

const manager = new ProviderSessionManager(
  runtime,
  sessions,
  async (_scope, request): Promise<ManagedAgentTurnRequest> => {
    hydrationCount += 1;
    return {
      ...request,
      persistedSummary: "Approved shared Telaegent conversation was injected",
      runtimePrompt: [
        "A provider session was unavailable. Continue using only this synthetic, approved shared conversation:",
        "User: What color is the demo status?",
        "Approved agent message: The demo status is teal.",
        "Return a short message stating the demo status color and set contextRecovered to true.",
        "Do not inspect files or call tools.",
      ].join("\n"),
    };
  },
);

console.log(`\nTelaegent ${provider} provider-session recovery proof`);
console.log("Workspace: isolated temporary directory");
console.log("Stored session: deliberately invalid in-memory reference");

try {
  const result = await manager.run<RecoveryResult>(
    scope,
    {
      agentId: `${provider}-recovery-proof`,
      purpose: "sender_draft",
      workspacePath,
      runtimePrompt: "Recover this turn from the approved shared conversation.",
      persistedSummary: "Synthetic recovery proof",
      sessionMode: "continue",
      sandboxMode: "read-only",
      networkMode: "none",
      outputSchemaName: "inline-recovery-proof.schema.json",
      correlationId: randomUUID(),
      maxTurns: 1,
    },
    progressPrinter,
  );
  assertRecoveryResult(result.final);

  const replacement = await sessions.get(scope);
  if (!failureCodes.includes("RUNTIME_SESSION_NOT_FOUND")) {
    throw new Error("The invalid provider session was not classified as missing");
  }
  if (attemptModes.join(",") !== "continue,fresh") {
    throw new Error(`Unexpected recovery attempts: ${attemptModes.join(",")}`);
  }
  if (hydrationCount !== 1) {
    throw new Error(`Expected one hydration, received ${hydrationCount}`);
  }
  if (!replacement || replacement.sessionId === invalidSessionId) {
    throw new Error("A replacement provider session was not stored");
  }

  console.log("\nRecovery verified:");
  console.log("- missing provider session classified safely");
  console.log("- stale in-memory reference replaced without printing either ID");
  console.log("- fresh provider session hydrated once from approved context");
  console.log(`- provider answer: ${result.final.message}`);
} finally {
  await rm(workspacePath, { recursive: true, force: true });
}
