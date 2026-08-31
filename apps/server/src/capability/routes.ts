import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { isGitHubRepositoryId } from "../authorization/github-repository-id.js";
import type { AuthenticatedUserResolver } from "../conversations/routes.js";
import { HttpError } from "../errors.js";
import { setPrivateNoStore } from "../http-cache.js";
import type { CapabilityScopeExpansionService } from "./service.js";

const uuid = z.string().uuid();
const scopeRequestParams = z.object({ scopeRequestId: uuid });
const listQuery = z.strictObject({
  // Decimal text, never a JSON number: a BIGINT repository id does not survive
  // a round trip through a JavaScript number intact.
  githubRepositoryId: z.string().refine(isGitHubRepositoryId),
});
/** The three buttons in build plan 8.1, and nothing else. */
const decisionBody = z.strictObject({
  decision: z.enum(["deny", "once", "task"]),
});

export interface CapabilityScopeRouteDependencies {
  service: CapabilityScopeExpansionService;
  authenticatedUserId: AuthenticatedUserResolver;
}

/**
 * These routes carry per-user authorization themselves, so app.ts exempts them
 * from the shared deployment token. Every entry must be the registered Fastify
 * path pattern, not a concrete URL.
 */
export const userAuthenticatedCapabilityRoutes = new Set([
  "/api/capability/scope-requests",
  "/api/capability/scope-requests/:scopeRequestId/decision",
]);

export function registerCapabilityScopeRoutes(
  app: FastifyInstance,
  dependencies: CapabilityScopeRouteDependencies,
): void {
  // What a peer's agent is waiting on this person to answer. Read-only, and
  // scoped to one repository because repository ID is the scope boundary.
  app.get("/api/capability/scope-requests", async (request, reply) => {
    setPrivateNoStore(reply);
    const authenticatedUserId = await user(request, dependencies.authenticatedUserId);
    const { githubRepositoryId } = listQuery.parse(request.query);
    return dependencies.service.listPendingScopeRequests(
      { authenticatedUserId, githubRepositoryId },
      abortWhenClientLeaves(request),
    );
  });

  // Deny, Allow once, or Allow for this task. This is the only place in the
  // product where reading someone else's file becomes permitted, and it is
  // always a person pressing it.
  app.post(
    "/api/capability/scope-requests/:scopeRequestId/decision",
    async (request, reply) => {
      setPrivateNoStore(reply);
      const authenticatedUserId = await user(request, dependencies.authenticatedUserId);
      const { scopeRequestId } = scopeRequestParams.parse(request.params);
      const { decision } = decisionBody.parse(request.body);
      return dependencies.service.decideScopeRequest(
        { authenticatedUserId, scopeRequestId, decision },
        abortWhenClientLeaves(request),
      );
    },
  );
}

/**
 * Stops talking to Supabase the moment the browser gives up on the answer.
 *
 * A decision that is already recorded stays recorded; what this cancels is
 * only the wait for its result.
 */
function abortWhenClientLeaves(request: FastifyRequest): { signal: AbortSignal } {
  const controller = new AbortController();
  request.raw.once("close", () => controller.abort());
  return { signal: controller.signal };
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
