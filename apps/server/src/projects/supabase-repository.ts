import type { z } from "zod";
import { HttpError } from "../errors.js";
import { SupabaseRpcTransport } from "../supabase-rpc-transport.js";
import type { ProjectRepository } from "./repository.js";
import {
  projectCollaboratorRowsSchema,
  projectConnectionSchema,
  projectConversationSchema,
  projectDisconnectSchema,
  projectSummaryRowsSchema,
  type ProjectCollaborator,
  type ProjectConnection,
  type ProjectConversation,
  type ProjectDisconnect,
  type ProjectSummary,
} from "./types.js";

export class SupabaseProjectRepository implements ProjectRepository {
  private readonly transport: SupabaseRpcTransport;

  constructor(
    supabaseUrl: string,
    secretKey: string,
    private readonly timeoutMs: number,
    fetchImplementation?: typeof fetch,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
      throw new Error("Project persistence configuration is invalid");
    }
    this.transport = new SupabaseRpcTransport({
      supabaseUrl,
      secretKey,
      maximumResponseBytes: 262_144,
      ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
    });
  }

  async listForUser(input: Readonly<{
    authenticatedUserId: string;
    afterGitHubRepositoryId: string | null;
    limit: number;
  }>): Promise<ProjectSummary[]> {
    const rows = await this.call("list_user_projects", {
      p_user_id: input.authenticatedUserId,
      p_after_github_repository_id: input.afterGitHubRepositoryId,
      p_limit: input.limit,
    }, projectSummaryRowsSchema);
    // Discovery has no refusal case: a caller with no projects gets an empty
    // array, so a null here is a malformed response.
    if (rows === null) throw unavailable();
    return rows;
  }

  async listCollaborators(input: Readonly<{
    authenticatedUserId: string;
    projectId: string;
    afterUserId: string | null;
    limit: number;
  }>): Promise<ProjectCollaborator[] | null> {
    return this.call("list_project_collaborators_page", {
      p_user_id: input.authenticatedUserId,
      p_project_id: input.projectId,
      p_after_user_id: input.afterUserId,
      p_limit: input.limit,
    }, projectCollaboratorRowsSchema);
  }

  async requestConnection(input: Readonly<{
    projectConnectionId: string;
    projectId: string;
    requesterUserId: string;
    recipientUserId: string;
    requestedAt: string;
  }>): Promise<ProjectConnection | null> {
    return this.call("request_project_connection", {
      p_project_connection_id: input.projectConnectionId,
      p_project_id: input.projectId,
      p_requester_user_id: input.requesterUserId,
      p_recipient_user_id: input.recipientUserId,
      p_requested_at: input.requestedAt,
    }, projectConnectionSchema);
  }

  async respondToConnection(input: Readonly<{
    projectConnectionId: string;
    recipientUserId: string;
    decision: "accept" | "decline";
    respondedAt: string;
  }>): Promise<ProjectConnection | null> {
    return this.call("respond_to_project_connection", {
      p_project_connection_id: input.projectConnectionId,
      p_recipient_user_id: input.recipientUserId,
      p_decision: input.decision,
      p_at: input.respondedAt,
    }, projectConnectionSchema);
  }

  async revokeConnection(input: Readonly<{
    projectConnectionId: string;
    authenticatedUserId: string;
    revokedAt: string;
  }>): Promise<ProjectConnection | null> {
    return this.call("revoke_project_connection", {
      p_project_connection_id: input.projectConnectionId,
      p_user_id: input.authenticatedUserId,
      p_at: input.revokedAt,
    }, projectConnectionSchema);
  }

  async disconnectRepository(input: Readonly<{
    authenticatedUserId: string;
    projectId: string;
  }>): Promise<ProjectDisconnect | null> {
    return this.call("disconnect_user_repository", {
      p_user_id: input.authenticatedUserId,
      p_project_id: input.projectId,
    }, projectDisconnectSchema);
  }

  async createConversation(input: Readonly<{
    conversationId: string;
    projectId: string;
    authenticatedUserId: string;
    peerUserId: string;
  }>): Promise<ProjectConversation | null> {
    return this.call("create_project_conversation", {
      p_conversation_id: input.conversationId,
      p_project_id: input.projectId,
      p_user_id: input.authenticatedUserId,
      p_peer_user_id: input.peerUserId,
    }, projectConversationSchema);
  }

  /**
   * Runs one RPC under a hard timeout.
   *
   * A JSON `null` is the database's fail-closed refusal and is passed through
   * untouched. Anything else that does not match the schema is a malformed
   * response and becomes a 503, so a shape drift can never be mistaken for a
   * successful authorization decision.
   */
  private async call<T>(
    functionName: string,
    params: Readonly<Record<string, unknown>>,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let value: unknown;
    try {
      value = await this.transport.call(functionName, params, {
        signal: controller.signal,
      });
    } catch {
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
    if (value === null) return null;
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  }
}

function unavailable(): HttpError {
  return new HttpError(503, "Project discovery is temporarily unavailable");
}
