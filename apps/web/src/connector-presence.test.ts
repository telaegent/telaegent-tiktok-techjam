import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "./api";
import { connectorPresence } from "./connector-presence";

function project(
  overrides: Partial<ProjectSummary> = {},
): ProjectSummary {
  return {
    projectId: "20000000-0000-4000-8000-000000000001",
    githubRepositoryId: "1",
    repositoryFullName: "owner/repository",
    visibility: "private",
    defaultBranch: "main",
    projectStatus: "active",
    membershipStatus: "active",
    membershipJoinedAt: "2026-09-01T00:00:00.000Z",
    githubConnectionStatus: "connected",
    repositoryAccessStatus: "verified",
    repositoryVerifiedAt: "2026-09-02T00:00:00.000Z",
    repositoryAccessFresh: true,
    connectedCollaboratorCount: 0,
    connectorLive: true,
    binding: {
      connectorBindingId: "30000000-0000-4000-8000-000000000001",
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

describe("connectorPresence", () => {
  it("reports connected when any verified project has a live connector", () => {
    expect(
      connectorPresence(
        [project({ connectorLive: false }), project()],
        false,
      ),
    ).toBe("connected");
  });

  it("reports checking while initial project discovery is in progress", () => {
    expect(connectorPresence([], true)).toBe("checking");
  });

  it("reports disconnected when no connector is live", () => {
    expect(connectorPresence([project({ connectorLive: false })], false)).toBe(
      "disconnected",
    );
  });

  it("never reports connected from live presence without current authorization", () => {
    expect(
      connectorPresence(
        [project({ repositoryAccessStatus: "revalidation_required" })],
        false,
      ),
    ).toBe("disconnected");
    expect(
      connectorPresence(
        [project({ membershipStatus: "revoked" })],
        false,
      ),
    ).toBe("disconnected");
    expect(
      connectorPresence(
        [
          project({
            binding: { ...project().binding, status: "unavailable" },
          }),
        ],
        false,
      ),
    ).toBe("disconnected");
  });

  it("reports checking while the last refresh is stale", () => {
    expect(connectorPresence([project()], false, true)).toBe("checking");
  });

  it("does not trust live transport after repository proof expiry", () => {
    const expired = project({
      repositoryAccessFresh: false,
    });
    expect(connectorPresence([expired], false, false)).toBe("disconnected");
  });
});
