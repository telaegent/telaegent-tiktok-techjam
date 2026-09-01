import type { ProjectSummary } from "./api";

export type ProjectAvailability =
  | "Open"
  | "Unavailable"
  | "Needs verification"
  | "Connector offline";

export type ProjectAction = "Open" | "Connect" | null;

// Mirrors the backend private-runtime authorization policy. Keep these values
// aligned with repository-proof/lifetime.ts and private-runtime-authorization.ts.
export const REPOSITORY_PROOF_MAX_AGE_MS = 15 * 60 * 1_000;
export const REPOSITORY_PROOF_CLOCK_SKEW_MS = 60_000;

export function repositoryProofIsFresh(
  verifiedAt: string,
  nowMs = Date.now(),
): boolean {
  const verifiedAtMs = Date.parse(verifiedAt);
  return (
    Number.isFinite(verifiedAtMs) &&
    Number.isFinite(nowMs) &&
    verifiedAtMs <= nowMs + REPOSITORY_PROOF_CLOCK_SKEW_MS &&
    nowMs - verifiedAtMs <= REPOSITORY_PROOF_MAX_AGE_MS
  );
}

export function projectAvailability(
  project: ProjectSummary,
  nowMs = Date.now(),
): ProjectAvailability {
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
  if (!repositoryProofIsFresh(project.repositoryVerifiedAt, nowMs)) {
    return "Needs verification";
  }
  if (project.binding.status !== "ready" || !project.connectorLive) {
    return "Connector offline";
  }
  return "Open";
}

export function projectAction(
  project: ProjectSummary,
  nowMs = Date.now(),
): ProjectAction {
  if (projectAvailability(project, nowMs) === "Open") return "Open";
  if (
    project.projectStatus !== "active" ||
    project.membershipStatus === "revoked" ||
    project.repositoryAccessStatus === "revoked" ||
    project.githubConnectionStatus === "revoked" ||
    project.binding.status === "revoked"
  ) {
    return null;
  }
  return "Connect";
}

export function partitionProjects(
  projects: readonly ProjectSummary[],
  nowMs = Date.now(),
): {
  active: ProjectSummary[];
  historical: ProjectSummary[];
} {
  const active: ProjectSummary[] = [];
  const historical: ProjectSummary[] = [];
  for (const project of projects) {
    (projectAvailability(project, nowMs) === "Open" ? active : historical).push(
      project,
    );
  }
  return { active, historical };
}
