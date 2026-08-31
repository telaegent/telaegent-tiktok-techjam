import { ApiError, type ProjectCollaborator, type ProjectConversation } from "./api";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const repositoryIdPattern = /^[1-9][0-9]*$/;

export function connectedCollaborators(
  collaborators: readonly ProjectCollaborator[],
): ProjectCollaborator[] {
  return collaborators.filter((candidate) => candidate.connectionStatus === "connected");
}

export function selectConnectedPeer(
  collaborators: readonly ProjectCollaborator[],
  currentPeerUserId: string | null,
): string | null {
  const connected = connectedCollaborators(collaborators);
  if (
    currentPeerUserId &&
    connected.some((candidate) => candidate.userId === currentPeerUserId)
  ) {
    return currentPeerUserId;
  }
  return connected[0]?.userId ?? null;
}

/**
 * Treat the browser response as untrusted even though the backend also checks
 * this scope. A stale response from a previous project or peer must never be
 * rendered as the selected conversation.
 */
export function assertConversationScope(input: Readonly<{
  conversation: ProjectConversation;
  projectId: string;
  githubRepositoryId: string;
  currentUserId: string;
  peerUserId: string;
}>): ProjectConversation {
  const { conversation } = input;
  const participants = new Set(conversation.participantUserIds);
  if (
    !uuidPattern.test(conversation.conversationId) ||
    conversation.projectId !== input.projectId ||
    !repositoryIdPattern.test(conversation.githubRepositoryId) ||
    conversation.githubRepositoryId !== input.githubRepositoryId ||
    conversation.status !== "active" ||
    conversation.participantUserIds.length !== 2 ||
    participants.size !== 2 ||
    !participants.has(input.currentUserId) ||
    !participants.has(input.peerUserId)
  ) {
    throw new ApiError(
      "Telaegent returned a conversation outside the selected project scope",
      502,
      "CONVERSATION_SCOPE_MISMATCH",
      false,
    );
  }
  return conversation;
}
