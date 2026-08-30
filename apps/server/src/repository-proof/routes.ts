import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { isGitHubRepositoryId } from "../authorization/github-repository-id.js";
import type { ConnectorPrincipal } from "./contract.js";
import type { RepositoryProofService } from "./service.js";

const repositoryParamsSchema = z.strictObject({
  githubRepositoryId: z
    .string()
    .refine((value) => isGitHubRepositoryId(value)),
});

/**
 * Implemented by Phuong's connector transport/authentication boundary.
 * It must authenticate the connector credential and return the account and
 * installation identity bound to that credential. Body fields are never used
 * to establish either identity.
 */
export type ConnectorPrincipalResolver = (
  request: FastifyRequest,
) => Promise<ConnectorPrincipal>;

export interface RepositoryProofRouteDependencies {
  service: RepositoryProofService;
  resolveConnectorPrincipal: ConnectorPrincipalResolver;
  onBindingRegistered?: (
    principal: Readonly<ConnectorPrincipal>,
    connectorBindingId: string,
    githubRepositoryId: string,
  ) => void;
}

export const connectorAuthenticatedRepositoryProofRoutes = new Set([
  "/api/connectors/repository-proofs",
  "/api/connectors/repositories/:githubRepositoryId/unavailable",
]);

export function registerRepositoryProofRoutes(
  app: FastifyInstance,
  dependencies: RepositoryProofRouteDependencies,
): void {
  app.post("/api/connectors/repository-proofs", async (request, reply) => {
    const principal = await dependencies.resolveConnectorPrincipal(request);
    const result = await dependencies.service.register(principal, request.body);
    dependencies.onBindingRegistered?.(
      principal,
      result.connectorBindingId,
      result.githubRepositoryId,
    );
    return reply.code(result.replayed ? 200 : 201).send({ binding: result });
  });

  app.post(
    "/api/connectors/repositories/:githubRepositoryId/unavailable",
    async (request) => {
      const principal = await dependencies.resolveConnectorPrincipal(request);
      const params = repositoryParamsSchema.parse(request.params);
      return {
        binding: await dependencies.service.markUnavailable(
          principal,
          params.githubRepositoryId,
          request.body,
        ),
      };
    },
  );
}
