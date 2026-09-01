import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "./api";
import {
  partitionProjects,
  projectAction,
  projectAvailability,
} from "./project-list";

function project(
  id: string,
  overrides: Partial<ProjectSummary> = {},
): ProjectSummary {
  return {
    projectId: `20000000-0000-4000-8000-${id.padStart(12, "0")}`,
    githubRepositoryId: id,
    repositoryFullName: `owner/repository-${id}`,
    visibility: "private",
    defaultBranch: "main",
    projectStatus: "active",
    membershipStatus: "active",
    membershipJoinedAt: "2026-09-01T00:00:00.000Z",
    githubConnectionStatus: "connected",
    repositoryAccessStatus: "verified",
    repositoryVerifiedAt: "2026-09-01T00:00:00.000Z",
    connectedCollaboratorCount: 0,
    connectorLive: true,
    binding: {
      connectorBindingId: `30000000-0000-4000-8000-${id.padStart(12, "0")}`,
      connectorInstanceId: "connector_instance_0001",
      status: "ready",
      currentBranch: "main",
      commitSha: "a".repeat(40),
      repositoryPermission: "write",
      lastVerifiedAt: "2026-09-01T00:00:00.000Z",
      lastSeenAt: "2026-09-01T00:00:00.000Z",
      unavailableReason: null,
    },
    ...overrides,
  };
}

describe("project list grouping", () => {
  it("treats durable ready state as active only while the connector is live", () => {
    expect(projectAvailability(project("1"))).toBe("Open");
    expect(projectAvailability(project("2", { connectorLive: false }))).toBe(
      "Connector offline",
    );
  });

  it("separates active projects from historical and stopped records", () => {
    const active = project("1");
    const offline = project("2", { connectorLive: false });
    const stopped = project("3", {
      binding: { ...project("3").binding, status: "stopped" },
    });
    const revoked = project("4", { membershipStatus: "revoked" });

    expect(partitionProjects([offline, active, revoked, stopped])).toEqual({
      active: [active],
      historical: [offline, revoked, stopped],
    });
  });

  it("offers a fresh connection command whenever a project cannot be opened", () => {
    expect(projectAction(project("1"))).toBe("Open");
    expect(projectAction(project("2", { connectorLive: false }))).toBe(
      "Connect",
    );
    expect(
      projectAction(
        project("3", {
          repositoryAccessStatus: "revalidation_required",
        }),
      ),
    ).toBe("Connect");
    expect(
      projectAction(project("4", { membershipStatus: "revoked" })),
    ).toBe("Connect");
  });
});
