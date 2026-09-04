import type {
  ProjectCollaborator,
  ProjectConnection,
  ProjectConversation,
  ProjectDisconnect,
  ProjectSummary,
} from "./types.js";

/**
 * Every method below returns `null` when the database refused the operation.
 *
 * The refusal is deliberately undifferentiated: the caller was not a member,
 * the peer never proved repository access, the pair was already connected, the
 * request had already been answered. Reporting which one would turn these
 * endpoints into an oracle over other people's project membership, so the
 * service maps `null` onto a single uninformative status.
 */
export interface ProjectRepository {
  listForUser(input: Readonly<{
    authenticatedUserId: string;
    afterGitHubRepositoryId: string | null;
    limit: number;
  }>): Promise<ProjectSummary[]>;

  listCollaborators(input: Readonly<{
    authenticatedUserId: string;
    projectId: string;
    afterUserId: string | null;
    limit: number;
  }>): Promise<ProjectCollaborator[] | null>;

  requestConnection(input: Readonly<{
    projectConnectionId: string;
    projectId: string;
    requesterUserId: string;
    recipientUserId: string;
    requestedAt: string;
  }>): Promise<ProjectConnection | null>;

  respondToConnection(input: Readonly<{
    projectConnectionId: string;
    recipientUserId: string;
    decision: "accept" | "decline";
    respondedAt: string;
  }>): Promise<ProjectConnection | null>;

  revokeConnection(input: Readonly<{
    projectConnectionId: string;
    authenticatedUserId: string;
    revokedAt: string;
  }>): Promise<ProjectConnection | null>;

  disconnectRepository(input: Readonly<{
    authenticatedUserId: string;
    projectId: string;
  }>): Promise<ProjectDisconnect | null>;

  createConversation(input: Readonly<{
    conversationId: string;
    projectId: string;
    authenticatedUserId: string;
    peerUserId: string;
  }>): Promise<ProjectConversation | null>;
}
