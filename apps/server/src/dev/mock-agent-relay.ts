import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { ClaudeCodeRunner } from "../claude-code-runner.js";
import { CodexRunner } from "../codex-runner.js";
import { loadConfig } from "../config.js";
import {
  runMockAgentRelay,
  type MockRelayEndpoint,
  type MockRelayStage,
} from "../mock-agent-relay.js";
import type {
  AgentProvider,
  JsonSchemaDocument,
  MiddlewareProviderRunner,
  MiddlewareRunRequest,
  RuntimeProgressEvent,
} from "../runtime-contract.js";

const messageSchema: JsonSchemaDocument = {
  type: "object",
  properties: { message: { type: "string", minLength: 1, maxLength: 500 } },
  required: ["message"],
  additionalProperties: false,
};

function promptFor(provider: AgentProvider, stage: MockRelayStage, input: string): string {
  const quotedInput = JSON.stringify(input);
  if (stage === "sender_prepare") {
    return [
      `You are ${provider}, Agent A in a local Telaegent relay demonstration.`,
      `The user asked: ${quotedInput}`,
      "Prepare one short outbound message for Agent B. Do not inspect files or use tools.",
    ].join("\n");
  }
  if (stage === "recipient_reply") {
    return [
      `You are ${provider}, Agent B in a local Telaegent relay demonstration.`,
      `Agent A sent: ${quotedInput}`,
      "Follow the request and return one short direct reply. Do not inspect files or use tools.",
    ].join("\n");
  }
  return [
    `You are ${provider}, Agent A continuing the same Telaegent session.`,
    `Agent B replied: ${quotedInput}`,
    "Acknowledge that you received the reply in one short sentence. Do not inspect files or use tools.",
  ].join("\n");
}

function messageFrom(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider returned an invalid relay payload");
  }
  const message = (value as Record<string, unknown>).message;
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("Provider returned an empty relay message");
  }
  return message.trim();
}

function cliEndpoint(options: {
  provider: AgentProvider;
  runner: MiddlewareProviderRunner;
  workspacePath: string;
}): MockRelayEndpoint {
  return {
    provider: options.provider,
    async runTurn(turn, onProgress) {
      const request: MiddlewareRunRequest = {
        agentId: `mock-${options.provider}`,
        provider: options.provider,
        purpose:
          turn.stage === "recipient_reply" ? "recipient_answer" : "sender_draft",
        workspacePath: options.workspacePath,
        runtimePrompt: promptFor(options.provider, turn.stage, turn.input),
        persistedSummary: `Local mock relay: ${turn.stage}`,
        ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
        sessionMode: turn.sessionId ? "continue" : "fresh",
        sandboxMode: "read-only",
        networkMode: "none",
        outputSchemaName: "mock-relay.schema.json",
        correlationId: randomUUID(),
        maxTurns: 2,
      };
      const result = await options.runner.runStructured(
        request,
        messageSchema,
        onProgress,
      );
      return {
        message: messageFrom(result.final),
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      };
    },
  };
}

function progressPrinter(event: RuntimeProgressEvent): void {
  const label = event.provider === "claude" ? "Claude" : "Codex";
  switch (event.type) {
    case "session_started":
      console.log(`[${label}] session started`);
      break;
    case "turn_started":
      console.log(`[${label}] working...`);
      break;
    case "activity_started":
      console.log(`[${label}] ${event.activity} started`);
      break;
    case "activity_completed":
      console.log(`[${label}] ${event.activity} completed`);
      break;
    case "retrying":
      console.log(`[${label}] retrying provider request (${event.attempt}/${event.maxRetries})`);
      break;
    case "turn_completed":
      console.log(`[${label}] turn completed`);
      break;
    case "text_delta":
      // The structured final messages are printed at the approval boundaries.
      break;
  }
}

const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const config = loadConfig({
  ...process.env,
  NODE_ENV: "development",
  CODEX_HOME: codexHome,
});
const claudeRunner = new ClaudeCodeRunner(config);
const codexRunner = new CodexRunner(config);
const [claudeCapability, codexCapability] = await Promise.all([
  claudeRunner.capability(),
  codexRunner.capability(),
]);

if (!claudeCapability.installed || !claudeCapability.authenticated) {
  throw new Error("Claude Code is not connected. Run `claude auth status` and sign in first.");
}
if (!codexCapability.installed || !codexCapability.authenticated) {
  throw new Error(
    `Codex is not connected in ${codexHome}. Run \`codex login\` for that CODEX_HOME first.`,
  );
}

const claudeWorkspace = await mkdtemp(path.join(tmpdir(), "telaegent-claude-a-"));
const codexWorkspace = await mkdtemp(path.join(tmpdir(), "telaegent-codex-b-"));

console.log("\nTelaegent local relay: Claude A -> Codex B -> Claude A");
console.log("The two agents use separate empty workspaces; approvals are simulated.\n");

try {
  const transcript = await runMockAgentRelay({
    sender: cliEndpoint({
      provider: "claude",
      runner: claudeRunner,
      workspacePath: claudeWorkspace,
    }),
    recipient: cliEndpoint({
      provider: "codex",
      runner: codexRunner,
      workspacePath: codexWorkspace,
    }),
    instruction: "Tell Codex to reply with exactly: hello",
    approve: async ({ from, to, message }) => {
      console.log(`[mock Send approval] ${from} -> ${to}: ${message}`);
      return message;
    },
    onProgress: progressPrinter,
  });

  console.log(`\nClaude draft: ${transcript.senderDraft}`);
  console.log(`Codex reply: ${transcript.recipientReply}`);
  console.log(`Claude received: ${transcript.senderReceipt}`);
} finally {
  await Promise.all([
    rm(claudeWorkspace, { recursive: true, force: true }),
    rm(codexWorkspace, { recursive: true, force: true }),
  ]);
}
