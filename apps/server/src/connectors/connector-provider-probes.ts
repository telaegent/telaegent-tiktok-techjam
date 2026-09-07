import type { AgentProvider } from "../runtime-contract.js";

/** One binding has one job lease: probe sequentially and retain partial success. */
export async function probeConnectorProviders(
  selected: readonly AgentProvider[],
  probe: (provider: AgentProvider) => Promise<void>,
  onFailure: (provider: AgentProvider, error: unknown) => void,
): Promise<AgentProvider[]> {
  const connected: AgentProvider[] = [];
  for (const provider of selected) {
    try {
      await probe(provider);
      connected.push(provider);
    } catch (error) {
      onFailure(provider, error);
    }
  }
  if (connected.length === 0) {
    throw new Error("No local coding provider passed the Telaegent live probe");
  }
  return connected;
}

/** A readiness-only command must fail if even one requested provider failed. */
export function assertAllSelectedProvidersConnected(
  selected: readonly AgentProvider[],
  connected: readonly AgentProvider[],
): void {
  if (selected.some((provider) => !connected.includes(provider))) {
    throw new Error("Not all selected providers passed the Telaegent live probe");
  }
}
