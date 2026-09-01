import type { ProjectSummary } from "./api";

export type ProjectAvailability =
  | "Open"
  | "Unavailable"
  | "Needs verification"
  | "Connector offline";

export type ProjectAction = "Open" | "Connect" | null;

export function projectAvailability(project: ProjectSummary): ProjectAvailability {
  if (
    project.projectStatus !== "active" ||
    project.membershipStatus !== "active"
  ) {
    return "Unavailable";
  }
  if (project.repositoryAccessStatus !== "verified") {
    return "Needs verification";
  }
  if (project.githubConnectionStatus !== "connected") {
    return "Needs verification";
  }
  if (project.binding.status !== "ready" || !project.connectorLive) {
    return "Connector offline";
  }
  return "Open";
}

export function projectAction(project: ProjectSummary): ProjectAction {
  if (projectAvailability(project) === "Open") return "Open";
  if (
    project.projectStatus !== "active" ||
    project.membershipStatus === "revoked" ||
    project.repositoryAccessStatus === "revoked" ||
    project.githubConnectionStatus === "revoked"
  ) {
    return null;
  }
  return "Connect";
}

export function partitionProjects(projects: readonly ProjectSummary[]): {
  active: ProjectSummary[];
  historical: ProjectSummary[];
} {
  const active: ProjectSummary[] = [];
  const historical: ProjectSummary[] = [];
  for (const project of projects) {
    (projectAvailability(project) === "Open" ? active : historical).push(project);
  }
  return { active, historical };
}
