import type { ProjectSummary } from "./api";
import { projectAvailability } from "./project-list";

export type ConnectorPresence = "checking" | "connected" | "disconnected";

export function connectorPresence(
  projects: readonly ProjectSummary[],
  loading: boolean,
  stale = false,
): ConnectorPresence {
  if (loading || stale) return "checking";
  return projects.some((project) => projectAvailability(project) === "Open")
    ? "connected"
    : "disconnected";
}
