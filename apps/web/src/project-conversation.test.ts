import { describe, expect, it } from "vitest";
import type { ProjectCollaborator, ProjectConversation } from "./api";
import {
  assertConversationScope,
  connectedCollaborators,
  selectConnectedPeer,
} from "./project-conversation";

const alice = "10000000-0000-4000-8000-000000000001";
const bob = "10000000-0000-4000-8000-000000000002";
const charlie = "10000000-0000-4000-8000-000000000003";
const projectId = "20000000-0000-4000-8000-000000000001";

function collaborator(
  userId: string,
  connectionStatus: ProjectCollaborator["connectionStatus"],
): ProjectCollaborator {
  return {
    userId,
    githubLogin: `user-${userId.at(-1)}`,
    connectionStatus,
    projectConnectionId:
      connectionStatus === "none" ? null : "30000000-0000-4000-8000-000000000001",
  };
}

function conversation(overrides: Partial<ProjectConversation> = {}): ProjectConversation {
  return {
    conversationId: "40000000-0000-4000-8000-000000000001",
    projectId,
    githubRepositoryId: "123456789",
    status: "active",
    participantUserIds: [alice, bob],
    created: false,
    ...overrides,
  };
}

describe("project conversation selection", () => {
  it("selects only connected peers and preserves a still-valid selection", () => {
    const peers = [
      collaborator(charlie, "pending_incoming"),
      collaborator(bob, "connected"),
    ];

    expect(connectedCollaborators(peers).map((peer) => peer.userId)).toEqual([bob]);
    expect(selectConnectedPeer(peers, bob)).toBe(bob);
    expect(selectConnectedPeer(peers, charlie)).toBe(bob);
  });

  it("returns no selection when the project has no connected peer", () => {
    expect(selectConnectedPeer([collaborator(bob, "pending_outgoing")], null)).toBeNull();
  });

  it("accepts only the selected project, repository, and participant pair", () => {
    expect(
      assertConversationScope({
        conversation: conversation(),
        projectId,
        githubRepositoryId: "123456789",
        currentUserId: alice,
        peerUserId: bob,
      }).conversationId,
    ).toBe("40000000-0000-4000-8000-000000000001");
  });

  it.each([
    ["another project", conversation({ projectId: "20000000-0000-4000-8000-000000000002" })],
    ["another repository", conversation({ githubRepositoryId: "987654321" })],
    ["another participant", conversation({ participantUserIds: [alice, charlie] })],
    ["a duplicated participant", conversation({ participantUserIds: [alice, alice] })],
  ])("fails closed for %s", (_label, value) => {
    expect(() =>
      assertConversationScope({
        conversation: value,
        projectId,
        githubRepositoryId: "123456789",
        currentUserId: alice,
        peerUserId: bob,
      }),
    ).toThrow("outside the selected project scope");
  });
});
