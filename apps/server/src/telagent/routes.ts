import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TelagentService } from "./service.js";

const safeId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/);
const projectParams = z.object({ projectId: safeId });
const operationParams = z.object({ operationId: safeId });
const conversationParams = z.object({ conversationId: safeId });
const messageBody = z.object({
  ownerId: safeId,
  agentId: safeId,
  content: z.string().trim().min(1).max(50_000),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  requestId: safeId.optional(),
  correlationId: safeId.optional(),
});

export function registerTelagentRoutes(
  app: FastifyInstance,
  service: TelagentService,
): void {
  app.post("/api/telagent/demo/initialize", async (request, reply) => {
    z.object({}).strict().optional().parse(request.body);
    return reply.code(201).send({ snapshot: await service.initializeDemo() });
  });

  app.get("/api/telagent/projects/:projectId/snapshot", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    return { snapshot: service.getProjectSnapshot(projectId) };
  });

  app.get("/api/telagent/operations/:operationId", async (request) => {
    const { operationId } = operationParams.parse(request.params);
    return { operation: service.getOperation(operationId) };
  });

  app.post(
    "/api/telagent/conversations/:conversationId/messages",
    async (request, reply) => {
      const { conversationId } = conversationParams.parse(request.params);
      const body = messageBody.parse(request.body);
      const operation = await service.submitConversationMessage({
        conversationId,
        ...body,
      });
      return reply.code(202).send(operation);
    },
  );
}
