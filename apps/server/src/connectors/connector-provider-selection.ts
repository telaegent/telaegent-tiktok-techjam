import { createInterface } from "node:readline/promises";
import type {
  AgentProvider,
  RuntimeCapabilities,
  RuntimeProviderCapability,
} from "../runtime-contract.js";
import type { ConnectorProviderSelection } from "./connector-cli-options.js";

const providerOrder = ["claude", "codex"] as const;

export async function selectConnectorProviders(
  selection: ConnectorProviderSelection,
  capabilities: RuntimeCapabilities,
  ask: (prompt: string) => Promise<string> = askInTerminal,
): Promise<readonly AgentProvider[]> {
  if (selection === "claude" || selection === "codex") {
    assertProviderAvailable(selection, capabilities[selection]);
    return [selection];
  }

  const available = providerOrder.filter(
    (provider) => capabilities[provider].authenticated,
  );
  if (available.length === 0) {
    throw new Error(
      "No authenticated Claude Code or Codex CLI is available; install and sign in to one provider locally, then retry",
    );
  }
  if (selection === "auto" || available.length === 1) return available;

  const answer = (await ask(
    [
      "\nTELAEGENT CODING PROVIDERS DETECTED",
      "1. Claude Code",
      "2. Codex CLI",
      "3. Both providers",
      "Choose which provider to connect [1-3]: ",
    ].join("\n"),
  )).trim().toLowerCase();

  if (answer === "1" || answer === "claude" || answer === "claude code") {
    return ["claude"];
  }
  if (answer === "2" || answer === "codex" || answer === "codex cli") {
    return ["codex"];
  }
  if (answer === "3" || answer === "both" || answer === "auto") {
    return available;
  }
  throw new Error(
    "Provider selection cancelled; choose 1, 2, or 3, or rerun with --provider claude|codex|auto; no pairing code was consumed",
  );
}

function assertProviderAvailable(
  provider: AgentProvider,
  capability: RuntimeProviderCapability,
): void {
  if (capability.authenticated) return;
  const label = provider === "claude" ? "Claude Code" : "Codex";
  if (!capability.installed || capability.reason === "not_installed") {
    throw new Error(
      `${label} CLI is not installed; install it or choose another provider; no pairing code was consumed`,
    );
  }
  throw new Error(
    `${label} CLI is not authenticated; sign in locally and retry; no pairing code was consumed`,
  );
}

async function askInTerminal(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Provider selection requires an interactive terminal; rerun with --provider claude|codex|auto; no pairing code was consumed",
    );
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(prompt);
  } finally {
    terminal.close();
  }
}
