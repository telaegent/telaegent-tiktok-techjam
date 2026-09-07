import { z } from "zod";
import type { AgentProvider } from "../runtime-contract.js";

export type ConnectorProviderSelection = AgentProvider | "auto" | "choose" | "both";

export type ConnectorCliOptions =
  | {
      command: "connect";
      workspaceCandidate: string;
      provider: ConnectorProviderSelection;
      probeOnly: boolean;
      serverOrigin?: string;
      connectorInstanceId?: string;
      credential?: string;
      pairingCode?: string;
    }
  | {
      command: "disconnect";
      workspaceCandidate: string;
      yes: boolean;
      serverOrigin?: string;
    }
  | {
      command: "auth";
      action: "status" | "logout";
      serverOrigin?: string;
    }
  | { command: "help" }
  | { command: "version" };

const providerSchema = z.enum(["choose", "auto", "both", "codex", "claude"]);

/** Parse only local operator input; provider and repository selection are never cloud-controlled. */
export function parseConnectorCliOptions(argv: readonly string[]): ConnectorCliOptions {
  if ((argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") && argv.length === 1) {
    return { command: "help" };
  }
  if ((argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") && argv.length === 1) {
    return { command: "version" };
  }
  if (argv[0] === "connect") return parseConnect(argv.slice(1));
  if (argv[0] === "disconnect") return parseDisconnect(argv.slice(1));
  if (argv[0] === "auth") return parseAuth(argv.slice(1));
  throw usageError();
}

function parseConnect(argv: readonly string[]): Extract<ConnectorCliOptions, { command: "connect" }> {
  let workspaceCandidate = ".";
  let workspaceSeen = false;
  let provider: ConnectorProviderSelection = "choose";
  let probeOnly = false;
  let serverOrigin: string | undefined;
  let connectorInstanceId: string | undefined;
  let credential: string | undefined;
  let pairingCode: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--provider") {
      const selected = argv[index + 1];
      if (!selected) throw usageError();
      provider = providerSchema.parse(selected);
      index += 1;
      continue;
    }
    if (value === "--url") {
      serverOrigin = requiredOptionValue(argv, index);
      index += 1;
      continue;
    }
    if (value === "--instance-id") {
      connectorInstanceId = requiredOptionValue(argv, index);
      index += 1;
      continue;
    }
    if (value === "--credential") {
      credential = requiredOptionValue(argv, index);
      index += 1;
      continue;
    }
    if (value === "--pair") {
      pairingCode = requiredOptionValue(argv, index);
      index += 1;
      continue;
    }
    if (value === "--probe-only") {
      probeOnly = true;
      continue;
    }
    if (value.startsWith("--") || workspaceSeen) throw usageError();
    workspaceCandidate = value;
    workspaceSeen = true;
  }
  if (pairingCode !== undefined && (connectorInstanceId || credential)) throw usageError();
  if ((connectorInstanceId === undefined) !== (credential === undefined)) throw usageError();
  return {
    command: "connect",
    workspaceCandidate,
    provider,
    probeOnly,
    ...(serverOrigin === undefined ? {} : { serverOrigin }),
    ...(connectorInstanceId === undefined ? {} : { connectorInstanceId }),
    ...(credential === undefined ? {} : { credential }),
    ...(pairingCode === undefined ? {} : { pairingCode }),
  };
}

function parseDisconnect(argv: readonly string[]): Extract<ConnectorCliOptions, { command: "disconnect" }> {
  let workspaceCandidate = ".";
  let workspaceSeen = false;
  let yes = false;
  let serverOrigin: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--url") {
      serverOrigin = requiredOptionValue(argv, index);
      index += 1;
      continue;
    }
    if (value === "--yes") {
      yes = true;
      continue;
    }
    if (value.startsWith("--") || workspaceSeen) throw usageError();
    workspaceCandidate = value;
    workspaceSeen = true;
  }
  return {
    command: "disconnect",
    workspaceCandidate,
    yes,
    ...(serverOrigin === undefined ? {} : { serverOrigin }),
  };
}

function parseAuth(argv: readonly string[]): Extract<ConnectorCliOptions, { command: "auth" }> {
  const action = argv[0];
  if (action !== "status" && action !== "logout") throw usageError();
  let serverOrigin: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] !== "--url") throw usageError();
    serverOrigin = requiredOptionValue(argv, index);
    index += 1;
  }
  return { command: "auth", action, ...(serverOrigin === undefined ? {} : { serverOrigin }) };
}

function requiredOptionValue(argv: readonly string[], index: number): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw usageError();
  return value;
}

export function connectorCliUsage(): string {
  return [
    "Usage:",
    "  tlg connect [workspace] [--provider choose|both|auto|codex|claude] [--probe-only]",
    "  tlg disconnect [workspace] [--yes]",
    "  tlg auth status|logout",
    "  tlg --help | --version",
    "",
    "choose: show both CLIs and choose locally; both: require both CLIs; auto: use available CLIs.",
    "To change providers, finish/cancel active work, press Ctrl+C, then reconnect with --provider choose.",
    "Advanced compatibility options: --url origin, --pair code, --instance-id id --credential bearer",
  ].join("\n");
}

function usageError(): Error {
  return new Error(connectorCliUsage());
}
