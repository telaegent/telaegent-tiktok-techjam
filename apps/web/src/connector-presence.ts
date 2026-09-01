import type { ProjectSummary } from "./api";

export type ConnectorPresence = "checking" | "connected" | "disconnected";

export function connectorPresence(
  projects: Array<Pick<ProjectSummary, "connectorLive">>,
  loading: boolean,
): ConnectorPresence {
  if (projects.some((project) => project.connectorLive)) return "connected";
  return loading ? "checking" : "disconnected";
}
