import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "./api";
import {
  partitionProjects,
  projectAction,
  projectAvailability,
  REPOSITORY_PROOF_CLOCK_SKEW_MS,
  REPOSITORY_PROOF_MAX_AGE_MS,
} from "./project-list";

const nowMs = Date.parse("2026-09-02T00:00:00.000Z");
const freshVerifiedAt = new Date().toISOString();

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
    repositoryVerifiedAt: freshVerifiedAt,
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

  it("matches the backend repository-proof freshness boundary", () => {
    expect(
      projectAvailability(
        project("1", {
          repositoryVerifiedAt: new Date(
            nowMs - REPOSITORY_PROOF_MAX_AGE_MS,
          ).toISOString(),
        }),
        nowMs,
      ),
    ).toBe("Open");
    expect(
      projectAvailability(
        project("2", {
          repositoryVerifiedAt: new Date(
            nowMs - REPOSITORY_PROOF_MAX_AGE_MS - 1,
          ).toISOString(),
        }),
        nowMs,
      ),
    ).toBe("Needs verification");
    expect(
      projectAvailability(
        project("3", {
          repositoryVerifiedAt: new Date(
            nowMs + REPOSITORY_PROOF_CLOCK_SKEW_MS + 1,
          ).toISOString(),
        }),
        nowMs,
      ),
    ).toBe("Needs verification");
    expect(
      projectAvailability(
        project("4", { repositoryVerifiedAt: "invalid" }),
        nowMs,
      ),
    ).toBe("Needs verification");
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
  });

  it("does not offer connection commands for terminal authorization states", () => {
    expect(
      projectAction(project("1", { projectStatus: "archived" })),
    ).toBeNull();
    expect(
      projectAction(project("2", { membershipStatus: "revoked" })),
    ).toBeNull();
    expect(
      projectAction(project("3", { repositoryAccessStatus: "revoked" })),
    ).toBeNull();
    expect(
      projectAction(project("4", { githubConnectionStatus: "revoked" })),
    ).toBeNull();
    expect(
      projectAction(
        project("5", {
          binding: { ...project("5").binding, status: "revoked" },
        }),
      ),
    ).toBeNull();
  });
});
