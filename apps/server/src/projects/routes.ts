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

export interface ProjectRouteDependencies {
  service: ProjectService;
  authenticatedUserId: AuthenticatedUserResolver;
}

export const userAuthenticatedProjectRoutes = new Set(["/api/projects"]);

export function registerProjectRoutes(
  app: FastifyInstance,
  dependencies: ProjectRouteDependencies,
): void {
  app.get("/api/projects", async (request, reply) => {
    setPrivateNoStore(reply);
    const authenticatedUserId = await user(request, dependencies.authenticatedUserId);
    const query = querySchema.parse(request.query);
    return dependencies.service.listProjects({
      authenticatedUserId,
      ...query,
    });
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
