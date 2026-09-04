import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isGitHubRepositoryId } from "../authorization/github-repository-id.js";
import { HttpError } from "../errors.js";
import type { ProjectRepository } from "./repository.js";
import type {
  ProjectCollaboratorListPage,
  ProjectConnection,
  ProjectConversation,
  ProjectDisconnect,
  ProjectListPage,
} from "./types.js";

const cursorPayload = z.strictObject({
  version: z.literal(1),
  afterGitHubRepositoryId: z.string().refine(isGitHubRepositoryId),
});
const collaboratorCursorPayload = z.strictObject({
  version: z.literal(1),
  afterUserId: z.string().uuid(),
});
const cursorPattern = /^[A-Za-z0-9_-]{1,256}$/;
const uuid = z.string().uuid();

export interface ProjectServiceOptions {
  now?: (() => Date) | undefined;
  createId?: (() => string) | undefined;
}

export class ProjectService {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly repository: ProjectRepository,
    options: ProjectServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async listProjects(input: Readonly<{
    authenticatedUserId: string;
    limit: number;
    cursor?: string | undefined;
  }>): Promise<ProjectListPage> {
    const userId = z.string().uuid().parse(input.authenticatedUserId);
    const limit = z.number().int().min(1).max(50).parse(input.limit);
    const afterGitHubRepositoryId = decodeCursor(input.cursor);
    const rows = await this.repository.listForUser({
      authenticatedUserId: userId,
      afterGitHubRepositoryId,
      limit: limit + 1,
    });
    if (rows.length > limit + 1) {
      throw new HttpError(503, "Project discovery is temporarily unavailable");
    }
    const projects = rows.slice(0, limit);
    const last = projects.at(-1);
    return {
      projects,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.githubRepositoryId)
          : null,
    };
  }

  /**
   * Project members who independently proved access to the same repository.
   *
   * This is not a GitHub collaborator listing. Nobody appears here because a
   * repository says they may; they appear because they connected their own
   * GitHub identity and proved the same repository ID themselves.
   */
  async listCollaborators(input: Readonly<{
    authenticatedUserId: string;
    projectId: string;
    limit: number;
    cursor?: string | undefined;
  }>): Promise<ProjectCollaboratorListPage> {
    const limit = z.number().int().min(1).max(50).parse(input.limit);
    const rows = await this.repository.listCollaborators({
      authenticatedUserId: uuid.parse(input.authenticatedUserId),
      projectId: uuid.parse(input.projectId),
      afterUserId: decodeCollaboratorCursor(input.cursor),
      limit: limit + 1,
    });
    if (rows === null) throw notAvailable();
    if (rows.length > limit + 1) {
      throw new HttpError(503, "Collaborator discovery is temporarily unavailable");
    }
    const collaborators = rows.slice(0, limit);
    const last = collaborators.at(-1);
    return {
      collaborators,
      nextCursor:
        rows.length > limit && last
          ? encodeCollaboratorCursor(last.userId)
          : null,
    };
  }

  /**
   * Asks a peer to connect on this project.
   *
   * The request grants nothing on its own; it only lets the recipient decide.
   * The connection ID is minted here rather than accepted from the client, so a
   * caller cannot aim a request at an existing row.
   */
  async requestConnection(input: Readonly<{
    authenticatedUserId: string;
    projectId: string;
    recipientUserId: string;
  }>): Promise<{ connection: ProjectConnection }> {
    const requesterUserId = uuid.parse(input.authenticatedUserId);
    const recipientUserId = uuid.parse(input.recipientUserId);
    if (requesterUserId === recipientUserId) {
      throw new HttpError(400, "A project connection needs two distinct people");
    }
    const connection = await this.repository.requestConnection({
      projectConnectionId: this.createId(),
      projectId: uuid.parse(input.projectId),
      requesterUserId,
      recipientUserId,
      requestedAt: this.now().toISOString(),
    });
    if (connection === null) throw notAvailable();
    return { connection };
  }

  /** Accepts or declines a pending request. Only the recipient may do this. */
  async respondToConnection(input: Readonly<{
    authenticatedUserId: string;
    projectConnectionId: string;
    decision: "accept" | "decline";
  }>): Promise<{ connection: ProjectConnection }> {
    const connection = await this.repository.respondToConnection({
      projectConnectionId: uuid.parse(input.projectConnectionId),
      recipientUserId: uuid.parse(input.authenticatedUserId),
      decision: input.decision,
      respondedAt: this.now().toISOString(),
    });
    if (connection === null) throw notAvailable();
    return { connection };
  }

  /**
   * Withdraws or revokes a connection. Either side may do this at any time, and
   * it takes effect on the next authorization check rather than on a schedule.
   */
  async revokeConnection(input: Readonly<{
    authenticatedUserId: string;
    projectConnectionId: string;
  }>): Promise<{ connection: ProjectConnection }> {
    const connection = await this.repository.revokeConnection({
      projectConnectionId: uuid.parse(input.projectConnectionId),
      authenticatedUserId: uuid.parse(input.authenticatedUserId),
      revokedAt: this.now().toISOString(),
    });
    if (connection === null) throw notAvailable();
    return { connection };
  }

  /**
   * Disconnects this user's local repository runtime from one project.
   *
   * This is deliberately narrower than revoking the user's Telaegent or GitHub
   * identity. The durable operation suspends only this membership and binding,
   * cancels its active tasks/grants, and requires a fresh local proof before it
   * can become ready again.
   */
  async disconnectRepository(input: Readonly<{
    authenticatedUserId: string;
    projectId: string;
  }>): Promise<{ disconnect: ProjectDisconnect }> {
    const disconnect = await this.repository.disconnectRepository({
      authenticatedUserId: uuid.parse(input.authenticatedUserId),
      projectId: uuid.parse(input.projectId),
    });
    if (disconnect === null) throw notAvailable();
    return { disconnect };
  }

  /**
   * Opens, or returns, the shared conversation for one connected pair.
   *
   * Idempotent on the pair: a second call returns the conversation already
   * open. That matters because the shared approved conversation is the
   * project's canonical memory, and splitting it across duplicate rows would
   * quietly lose collaboration history.
   */
  async createConversation(input: Readonly<{
    authenticatedUserId: string;
    projectId: string;
    peerUserId: string;
  }>): Promise<{ conversation: ProjectConversation }> {
    const authenticatedUserId = uuid.parse(input.authenticatedUserId);
    const peerUserId = uuid.parse(input.peerUserId);
    if (authenticatedUserId === peerUserId) {
      throw new HttpError(400, "A conversation needs two distinct participants");
    }
    const conversation = await this.repository.createConversation({
      conversationId: this.createId(),
      projectId: uuid.parse(input.projectId),
      authenticatedUserId,
      peerUserId,
    });
    if (conversation === null) throw notAvailable();
    return { conversation };
  }
}

/**
 * The single refusal for every connection operation.
 *
 * Not a member, peer never proved access, already connected, already answered,
 * project archived: all of these collapse to one status with one message. A
 * caller who is not entitled to act learns only that, never anything about the
 * project's membership or another person's state.
 */
function notAvailable(): HttpError {
  return new HttpError(403, "This project connection action is not available");
}

function decodeCursor(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!cursorPattern.test(value)) throw invalidCursor();
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value || bytes.byteLength > 192) {
      throw invalidCursor();
    }
    const parsed = cursorPayload.parse(JSON.parse(bytes.toString("utf8")));
    return parsed.afterGitHubRepositoryId;
  } catch {
    throw invalidCursor();
  }
}

function encodeCursor(afterGitHubRepositoryId: string): string {
  return Buffer.from(
    JSON.stringify({ version: 1, afterGitHubRepositoryId }),
    "utf8",
  ).toString("base64url");
}

function decodeCollaboratorCursor(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!cursorPattern.test(value)) throw invalidCollaboratorCursor();
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value || bytes.byteLength > 192) {
      throw invalidCollaboratorCursor();
    }
    return collaboratorCursorPayload.parse(
      JSON.parse(bytes.toString("utf8")),
    ).afterUserId;
  } catch {
    throw invalidCollaboratorCursor();
  }
}

function encodeCollaboratorCursor(afterUserId: string): string {
  return Buffer.from(
    JSON.stringify({ version: 1, afterUserId }),
    "utf8",
  ).toString("base64url");
}

function invalidCursor(): z.ZodError {
  return new z.ZodError([
    {
      code: "custom",
      path: ["cursor"],
      message: "Invalid project cursor",
    },
  ]);
}

function invalidCollaboratorCursor(): z.ZodError {
  return new z.ZodError([
    {
      code: "custom",
      path: ["cursor"],
      message: "Invalid collaborator cursor",
    },
  ]);
}
