import { z } from "zod";
import type { AgentProvider } from "../runtime-contract.js";

export type ConnectorProviderSelection = AgentProvider | "auto";

export interface ConnectorCliOptions {
  workspaceCandidate: string;
  provider: ConnectorProviderSelection;
}

const providerSchema = z.enum(["auto", "codex", "claude"]);

/** Parse only local operator input; provider selection is never cloud-controlled. */
export function parseConnectorCliOptions(argv: readonly string[]): ConnectorCliOptions {
  if (argv[0] !== "connect") throw usageError();

  let workspaceCandidate = ".";
  let workspaceSeen = false;
  let provider: ConnectorProviderSelection = "auto";
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--provider") {
      const selected = argv[index + 1];
      if (!selected) throw usageError();
      provider = providerSchema.parse(selected);
      index += 1;
      continue;
    }
    if (value.startsWith("--") || workspaceSeen) throw usageError();
    workspaceCandidate = value;
    workspaceSeen = true;
  }
  return { workspaceCandidate, provider };
}

function usageError(): Error {
  return new Error(
    "Usage: telaegent connect [workspace] [--provider auto|codex|claude]",
  );
}
