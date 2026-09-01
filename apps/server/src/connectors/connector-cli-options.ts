import { z } from "zod";
import type { AgentProvider } from "../runtime-contract.js";

export type ConnectorProviderSelection = AgentProvider | "auto";

export interface ConnectorCliOptions {
  workspaceCandidate: string;
  provider: ConnectorProviderSelection;
  probeOnly: boolean;
  serverOrigin?: string;
  connectorInstanceId?: string;
  credential?: string;
  pairingCode?: string;
}

const providerSchema = z.enum(["auto", "codex", "claude"]);

/** Parse only local operator input; provider selection is never cloud-controlled. */
export function parseConnectorCliOptions(argv: readonly string[]): ConnectorCliOptions {
  if (argv[0] !== "connect") throw usageError();

  let workspaceCandidate = ".";
  let workspaceSeen = false;
  let provider: ConnectorProviderSelection = "auto";
  let probeOnly = false;
  let serverOrigin: string | undefined;
  let connectorInstanceId: string | undefined;
  let credential: string | undefined;
  let pairingCode: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
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
  if (pairingCode !== undefined && (connectorInstanceId || credential)) {
    throw usageError();
  }
  return {
    workspaceCandidate,
    provider,
    probeOnly,
    ...(serverOrigin === undefined ? {} : { serverOrigin }),
    ...(connectorInstanceId === undefined ? {} : { connectorInstanceId }),
    ...(credential === undefined ? {} : { credential }),
    ...(pairingCode === undefined ? {} : { pairingCode }),
  };
}

function requiredOptionValue(argv: readonly string[], index: number): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw usageError();
  return value;
}

function usageError(): Error {
  return new Error(
    "Usage: telaegent connect [workspace] [--url origin] [--pair code | --instance-id id --credential bearer] [--provider auto|codex|claude] [--probe-only]",
  );
}
