import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConnectorPrincipalResolver } from "../repository-proof/routes.js";
import type { RuntimeProgressEvent } from "../runtime-contract.js";
import type { AuthenticatedUserResolver } from "../conversations/routes.js";
import type { ConnectorCredentialService } from "./connector-credentials.js";
import type { LongPollConnectorJobRelay } from "./long-poll-job-relay.js";

const bindingIdSchema = z.string().uuid();
const jobIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const pollQuerySchema = z.strictObject({
  connectorBindingId: bindingIdSchema,
  waitMs: z.coerce.number().int().min(0).max(25_000).default(20_000),
});
const jobParamsSchema = z.strictObject({ jobId: jobIdSchema });
const credentialBodySchema = z.strictObject({
  connectorInstanceId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
});
const credentialParamsSchema = credentialBodySchema;
const bindingParamsSchema = z.strictObject({ connectorBindingId: bindingIdSchema });
const relativeChangedPath = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    const normalized = value.replaceAll("\\", "/");
    return (
      !normalized.startsWith("/") &&
      !/^[A-Za-z]:\//.test(normalized) &&
      !normalized.split("/").includes("..") &&
      !/[\u0000\r\n]/.test(normalized)
    );
  });
const resultSchema = z.strictObject({
  provider: z.enum(["codex", "claude"]),
  final: z.unknown(),
  changedFiles: z.array(relativeChangedPath).max(100),
  exitCode: z.number().int().min(0).max(255),
  durationMs: z.number().int().min(0).max(3_600_000),
});
const failureSchema = z.strictObject({
  code: z.enum([
    "RUNTIME_UNAVAILABLE",
    "RUNTIME_AUTHENTICATION_FAILED",
    "RUNTIME_SESSION_NOT_FOUND",
    "RUNTIME_TIMEOUT",
    "RUNTIME_OUTPUT_LIMIT",
    "INVALID_AGENT_OUTPUT",
    "UNSUPPORTED_RUNTIME_POLICY",
    "RUNTIME_FAILED",
  ]),
});
const providerSchema = z.enum(["codex", "claude"]);
const failureDetailSchema = z.strictObject({
  code: z.enum([
    "RUNTIME_UNAVAILABLE",
    "RUNTIME_AUTHENTICATION_FAILED",
    "RUNTIME_SESSION_NOT_FOUND",
    "RUNTIME_TIMEOUT",
    "RUNTIME_OUTPUT_LIMIT",
    "INVALID_AGENT_OUTPUT",
    "UNSUPPORTED_RUNTIME_POLICY",
    "RUNTIME_FAILED",
    "RUNTIME_CANCELLED",
  ]),
  error: z.string().min(1).max(256),
  retryable: z.boolean(),
});
const progressSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("session_started"), provider: providerSchema }),
  z.strictObject({ type: z.literal("turn_started"), provider: providerSchema }),
  z.strictObject({
    type: z.literal("text_delta"),
    provider: providerSchema,
    text: z.string().max(16_384),
  }),
  z.strictObject({
    type: z.enum(["activity_started", "activity_completed"]),
    provider: providerSchema,
    activity: z.enum(["command", "file_change", "mcp", "web_search", "tool"]),
  }),
  z.strictObject({
    type: z.literal("retrying"),
    provider: providerSchema,
    attempt: z.number().int().positive().max(10),
    maxRetries: z.number().int().positive().max(10),
    retryDelayMs: z.number().int().min(0).max(60_000),
  }),
  z.strictObject({
    type: z.enum(["turn_cancelled", "turn_timed_out", "turn_failed"]),
    provider: providerSchema,
    failure: failureDetailSchema,
    allowedActions: z.array(
      z.enum(["retry", "reconnect_provider", "edit_request", "dismiss"]),
    ).max(4),
  }),
  z.strictObject({ type: z.literal("turn_completed"), provider: providerSchema }),
]);

export interface ConnectorTransportRouteDependencies {
  relay: LongPollConnectorJobRelay;
  resolveConnectorPrincipal: ConnectorPrincipalResolver;
  credentials?: ConnectorCredentialService | undefined;
  authenticatedUserId?: AuthenticatedUserResolver | undefined;
}

export const connectorTransportRoutes = new Set([
  "/api/connectors/jobs/next",
  "/api/connectors/jobs/:jobId/progress",
  "/api/connectors/jobs/:jobId/result",
  "/api/connectors/jobs/:jobId/failure",
  "/api/connectors/credentials",
  "/api/connectors/credentials/:connectorInstanceId",
  "/api/connectors/bindings/:connectorBindingId/probe",
  "/api/connectors/session",
]);

export function registerConnectorTransportRoutes(
  app: FastifyInstance,
  dependencies: ConnectorTransportRouteDependencies,
): void {
  app.get("/api/connectors/session", async (request) => ({
    connector: await dependencies.resolveConnectorPrincipal(request),
  }));

  if (dependencies.credentials && dependencies.authenticatedUserId) {
    app.post("/api/connectors/credentials", async (request, reply) => {
      const authenticatedUserId = await dependencies.authenticatedUserId!(request);
      const body = credentialBodySchema.parse(request.body);
      dependencies.relay.unregisterPrincipal({
        authenticatedUserId,
        connectorInstanceId: body.connectorInstanceId,
      });
      return reply.code(201).send({
        connector: await dependencies.credentials!.issue(
          authenticatedUserId,
          body.connectorInstanceId,
        ),
      });
    });

    app.delete(
      "/api/connectors/credentials/:connectorInstanceId",
      async (request, reply) => {
        const authenticatedUserId = await dependencies.authenticatedUserId!(request);
        const params = credentialParamsSchema.parse(request.params);
        await dependencies.credentials!.revoke(
          authenticatedUserId,
          params.connectorInstanceId,
        );
        dependencies.relay.unregisterPrincipal({
          authenticatedUserId,
          connectorInstanceId: params.connectorInstanceId,
        });
        return reply.code(204).send();
      },
    );
  }

  app.post(
    "/api/connectors/bindings/:connectorBindingId/probe",
    async (request) => {
      const principal = await dependencies.resolveConnectorPrincipal(request);
      const { connectorBindingId } = bindingParamsSchema.parse(request.params);
      const githubRepositoryId = dependencies.relay.registeredRepository(
        principal,
        connectorBindingId,
      );
      const result = await dependencies.relay.dispatch<{ message: string }>({
        jobId: randomUUID(),
        connectorBindingId,
        userId: principal.authenticatedUserId,
        githubRepositoryId,
        conversationId: `connector-probe:${connectorBindingId}`,
        provider: "claude",
        purpose: "sender_draft",
        runtimePrompt: [
          "This is a Telaegent connector probe.",
          "Do not inspect files or call tools.",
          'Print exactly: TELAEGENT IS CONNECTED',
        ].join("\n"),
        persistedSummary: "Connector provider probe",
        sessionMode: "ephemeral",
        sandboxMode: "read-only",
        networkMode: "none",
        outputSchemaName: "connector-connection-probe.schema.json",
        correlationId: randomUUID(),
        maxTurns: 1,
      });
      if (
        !result.final ||
        typeof result.final !== "object" ||
        result.final.message !== "TELAEGENT IS CONNECTED"
      ) {
        throw new Error("Connector provider probe returned an invalid result");
      }
      return {
        connected: true,
        provider: "claude",
        durationMs: result.durationMs,
      };
    },
  );

  app.get("/api/connectors/jobs/next", async (request, reply) => {
    const principal = await dependencies.resolveConnectorPrincipal(request);
    const query = pollQuerySchema.parse(request.query);
    // A connector abandons this poll whenever it stops waiting - it finished a
    // job, restarted, or crashed. The relay must release the binding's single
    // waiter slot then, not when the abandoned wait finally elapses.
    const abandoned = new AbortController();
    const release = (): void => {
      if (!reply.raw.writableFinished) abandoned.abort();
    };
    reply.raw.once("close", release);
    try {
      const delivery = await dependencies.relay.poll(
        principal,
        query.connectorBindingId,
        query.waitMs,
        abandoned.signal,
      );
      return delivery ? reply.send(delivery) : reply.code(204).send();
    } finally {
      reply.raw.off("close", release);
    }
  });

  app.post("/api/connectors/jobs/:jobId/progress", async (request, reply) => {
    const principal = await dependencies.resolveConnectorPrincipal(request);
    const { jobId } = jobParamsSchema.parse(request.params);
    const progress = progressSchema.parse(request.body) as RuntimeProgressEvent;
    return dependencies.relay.publishProgress(principal, jobId, progress)
      ? reply.code(204).send()
      : reply.code(409).send({ error: "Connector job is no longer active" });
  });

  app.post("/api/connectors/jobs/:jobId/result", async (request, reply) => {
    const principal = await dependencies.resolveConnectorPrincipal(request);
    const { jobId } = jobParamsSchema.parse(request.params);
    const result = resultSchema.parse(request.body);
    return dependencies.relay.complete(principal, jobId, result)
      ? reply.code(204).send()
      : reply.code(409).send({ error: "Connector job is no longer active" });
  });

  app.post("/api/connectors/jobs/:jobId/failure", async (request, reply) => {
    const principal = await dependencies.resolveConnectorPrincipal(request);
    const { jobId } = jobParamsSchema.parse(request.params);
    const failure = failureSchema.parse(request.body);
    return dependencies.relay.fail(principal, jobId, failure.code)
      ? reply.code(204).send()
      : reply.code(409).send({ error: "Connector job is no longer active" });
  });
}
