import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthenticatedUserResolver } from "../conversations/routes.js";
import { HttpError } from "../errors.js";
import { setPrivateNoStore } from "../http-cache.js";
import type { ProjectService } from "./service.js";

const querySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
});
const uuid = z.string().uuid();
const projectParams = z.object({ projectId: uuid });
const connectionParams = z.object({ projectId: uuid, connectionId: uuid });
const collaboratorQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
const requestConnectionBody = z.strictObject({ recipientUserId: uuid });
const respondBody = z.strictObject({ decision: z.enum(["accept", "decline"]) });
const emptyBody = z.strictObject({}).optional();
const createConversationBody = z.strictObject({ peerUserId: uuid });

export interface ProjectRouteDependencies {
  service: ProjectService;
  authenticatedUserId: AuthenticatedUserResolver;
  isBindingOnline?: (
    authenticatedUserId: string,
    connectorBindingId: string,
  ) => boolean;
  onRepositoryDisconnected?: (
    authenticatedUserId: string,
    githubRepositoryId: string,
  ) => void | Promise<void>;
}

/**
 * These routes carry per-user authorization themselves, so app.ts exempts them
 * from the shared deployment token. Every entry must be the registered Fastify
 * path pattern, not a concrete URL.
 */
export const userAuthenticatedProjectRoutes = new Set([
  "/api/projects",
  "/api/projects/:projectId/collaborators",
  "/api/projects/:projectId/connections",
  "/api/projects/:projectId/connections/:connectionId/respond",
  "/api/projects/:projectId/connections/:connectionId/revoke",
  "/api/projects/:projectId/disconnect",
  "/api/projects/:projectId/conversations",
]);

export function registerProjectRoutes(
  app: FastifyInstance,
  dependencies: ProjectRouteDependencies,
): void {
  app.get("/api/projects", async (request, reply) => {
    setPrivateNoStore(reply);
    const authenticatedUserId = await user(request, dependencies.authenticatedUserId);
    const query = querySchema.parse(request.query);
    const page = await dependencies.service.listProjects({
      authenticatedUserId,
      ...query,
    });
    return {
      ...page,
      projects: page.projects.map((project) => ({
        ...project,
        connectorLive: dependencies.isBindingOnline?.(
          authenticatedUserId,
          project.binding.connectorBindingId,
        ) ?? false,
      })),
    };
  });

  // Who on this project could be asked to connect, and where each pair stands.
  app.get("/api/projects/:projectId/collaborators", async (request, reply) => {
    setPrivateNoStore(reply);
    const authenticatedUserId = await user(request, dependencies.authenticatedUserId);
    const { projectId } = projectParams.parse(request.params);
    const { limit } = collaboratorQuery.parse(request.query);
    return dependencies.service.listCollaborators({
      authenticatedUserId,
      projectId,
      limit,
    });
  });

  // Ask a peer to connect. This creates a request, never a connection: the
  // recipient still holds the decision.
  app.post("/api/projects/:projectId/connections", async (request, reply) => {
    setPrivateNoStore(reply);
    const authenticatedUserId = await user(request, dependencies.authenticatedUserId);
    const { projectId } = projectParams.parse(request.params);
    const body = requestConnectionBody.parse(request.body);
    const result = await dependencies.service.requestConnection({
      authenticatedUserId,
      projectId,
      ...body,
    });
    return reply.code(201).send(result);
  });

  app.post(
    "/api/projects/:projectId/connections/:connectionId/respond",
    async (request, reply) => {
      setPrivateNoStore(reply);
      const authenticatedUserId = await user(request, dependencies.authenticatedUserId);
      const { connectionId } = connectionParams.parse(request.params);
      const body = respondBody.parse(request.body);
      return dependencies.service.respondToConnection({
        authenticatedUserId,
        projectConnectionId: connectionId,
        ...body,
      });
    },
  );

  app.post("/api/projects/:projectId/disconnect", async (request, reply) => {
    setPrivateNoStore(reply);
    const authenticatedUserId = await user(request, dependencies.authenticatedUserId);
    const { projectId } = projectParams.parse(request.params);
    emptyBody.parse(request.body);
    const result = await dependencies.service.disconnectRepository({
      authenticatedUserId,
      projectId,
    });
    // Await process-local cancellation after durable revocation. Retrying the
    // idempotent route heals a callback failure without restoring authority.
    await dependencies.onRepositoryDisconnected?.(
      authenticatedUserId,
      result.disconnect.githubRepositoryId,
    );
    return reply.send(result);
  });

  app.post(
    "/api/projects/:projectId/connections/:connectionId/revoke",
    async (request, reply) => {
      setPrivateNoStore(reply);
      const authenticatedUserId = await user(request, dependencies.authenticatedUserId);
      const { connectionId } = connectionParams.parse(request.params);
      emptyBody.parse(request.body);
      return dependencies.service.revokeConnection({
        authenticatedUserId,
        projectConnectionId: connectionId,
      });
    },
  );

  // Open the shared conversation for a connected pair. Idempotent, so the
  // browser may call it whenever a collaborator's thread is entered.
  app.post("/api/projects/:projectId/conversations", async (request, reply) => {
    setPrivateNoStore(reply);
    const authenticatedUserId = await user(request, dependencies.authenticatedUserId);
    const { projectId } = projectParams.parse(request.params);
    const body = createConversationBody.parse(request.body);
    const result = await dependencies.service.createConversation({
      authenticatedUserId,
      projectId,
      ...body,
    });
    return reply.code(result.conversation.created ? 201 : 200).send(result);
  });
}

async function user(
  request: FastifyRequest,
  resolve: AuthenticatedUserResolver,
): Promise<string> {
  const userId = await resolve(request);
  if (!uuid.safeParse(userId).success) {
    throw new HttpError(401, "Authentication required");
  }
  return userId;
}
