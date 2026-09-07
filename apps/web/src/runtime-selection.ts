import type { AgentProvider, RuntimeModelCatalogue } from "./api";

/** Pick an initial provider once; never replace an existing choice when it goes offline. */
export function selectAvailableProvider(
  catalogue: RuntimeModelCatalogue | null,
  current: AgentProvider | null,
): AgentProvider | null {
  if (!catalogue || catalogue.providers.length === 0) return null;
  if (current === null) return catalogue.providers[0]!.provider;
  return catalogue.providers.some((candidate) => candidate.provider === current)
    ? current
    : null;
}
