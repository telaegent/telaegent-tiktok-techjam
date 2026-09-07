import { createInterface } from "node:readline/promises";
import type {
  AgentProvider,
  RuntimeCapabilities,
  RuntimeProviderCapability,
} from "../runtime-contract.js";
import type { ConnectorProviderSelection } from "./connector-cli-options.js";

const providerOrder = ["claude", "codex"] as const;

/** Keep an explicit local choice from even probing the unselected executable. */
export function connectorProviderCandidates(
  selection: ConnectorProviderSelection,
): readonly AgentProvider[] {
  return selection === "claude" || selection === "codex"
    ? [selection]
    : providerOrder;
}

export async function selectConnectorProviders(
  selection: ConnectorProviderSelection,
  detect: RuntimeCapabilities | (() => Promise<RuntimeCapabilities>),
  ask: (prompt: string) => Promise<string> = askInTerminal,
): Promise<readonly AgentProvider[]> {
  for (;;) {
    const capabilities = typeof detect === "function" ? await detect() : detect;
    if (selection === "claude" || selection === "codex") {
      assertProviderAvailable(selection, capabilities[selection]);
      return [selection];
    }

    const available = providerOrder.filter(
      (provider) => capabilities[provider].authenticated,
    );
    if (selection === "both") {
      for (const provider of providerOrder) assertProviderAvailable(provider, capabilities[provider]);
      return providerOrder;
    }
    if (selection === "auto" && available.length === 0) {
      throw new Error(
        "No authenticated Claude Code or Codex CLI is available; install and sign in to one provider locally, then retry",
      );
    }
    if (selection === "auto") return available;

    const answer = (await ask(
      [
        "\nTELAEGENT CODING PROVIDERS DETECTED",
        `1. Claude Code — ${providerDetectionStatus(capabilities.claude)}`,
        `2. Codex CLI — ${providerDetectionStatus(capabilities.codex)}`,
        "3. Both providers (requires both to be available)",
        ...(typeof detect === "function" ? ["4. Check again after fixing local CLI setup in another terminal"] : []),
        "q. Cancel",
        "Available means local checks passed; connection still requires a live probe.",
        "Choose a provider, check again, or cancel: ",
      ].join("\n"),
    )).trim().toLowerCase();

    if (answer === "1" || answer === "claude" || answer === "claude code") {
      assertProviderAvailable("claude", capabilities.claude);
      return ["claude"];
    }
    if (answer === "2" || answer === "codex" || answer === "codex cli") {
      assertProviderAvailable("codex", capabilities.codex);
      return ["codex"];
    }
    if (answer === "3" || answer === "both") {
      for (const provider of providerOrder) assertProviderAvailable(provider, capabilities[provider]);
      return providerOrder;
    }
    if ((answer === "4" || answer === "retry") && typeof detect === "function") continue;
    throw new Error(
      "Provider selection cancelled; rerun with --provider choose|claude|codex|both|auto; no pairing code was consumed",
    );
  }
}

export function providerDetectionStatus(capability: RuntimeProviderCapability): string {
  if (capability.authenticated) return "Available";
  if (capability.reason === "probe_failed") {
    return "Local CLI check failed; verify the CLI runs in this terminal and retry";
  }
  if (!capability.installed || capability.reason === "not_installed") {
    return "CLI executable unavailable; install it locally or check PATH, then retry";
  }
  return "Not signed in; sign in to the CLI locally, then retry";
}

function assertProviderAvailable(
  provider: AgentProvider,
  capability: RuntimeProviderCapability,
): void {
  if (capability.authenticated) return;
  const label = provider === "claude" ? "Claude Code" : "Codex";
  throw new Error(
    `${label}: ${providerDetectionStatus(capability)}; no pairing code was consumed`,
  );
}

async function askInTerminal(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Provider selection requires an interactive terminal; rerun with --provider claude|codex|both|auto; no pairing code was consumed",
    );
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(prompt);
  } finally {
    terminal.close();
  }
}
