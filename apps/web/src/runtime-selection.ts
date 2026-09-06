import type { AgentProvider, RuntimeModelCatalogue } from "./api";

/** Returns a usable current choice, falling back to the connector's first live provider. */
export function selectAvailableProvider(
  catalogue: RuntimeModelCatalogue | null,
  current: AgentProvider,
): AgentProvider | null {
  if (!catalogue || catalogue.providers.length === 0) return null;
  return catalogue.providers.some((candidate) => candidate.provider === current)
    ? current
    : catalogue.providers[0]!.provider;
}
