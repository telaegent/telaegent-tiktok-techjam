import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConnectorPrincipalResolver } from "../repository-proof/routes.js";
import type { RuntimeProgressEvent } from "../runtime-contract.js";
import type { AuthenticatedUserResolver } from "../conversations/routes.js";
import { setPrivateNoStore } from "../http-cache.js";
import type { ConnectorCredentialService } from "./connector-credentials.js";
import type { ConnectorPairingService } from "./connector-pairing.js";
import type { LongPollConnectorJobRelay } from "./long-poll-job-relay.js";
import type { ConnectorPrincipal } from "../repository-proof/contract.js";
import {
  connectorResourceRequestSchema,
  resourceExchangeResponseSchema,
} from "./resource-exchange.js";

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
const pairingExchangeSchema = z.strictObject({
  pairingCode: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
});
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
  /**
   * What this turn asked a peer for. Bounded here so one turn cannot enqueue an
   * unbounded number of questions for another person's machine to answer.
   */
  resourceRequests: z.array(connectorResourceRequestSchema).max(16).optional(),
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
const probeBodySchema = z.strictObject({ provider: providerSchema });
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
  pairings?: ConnectorPairingService | undefined;
  authenticatedUserId?: AuthenticatedUserResolver | undefined;
}

export const connectorTransportRoutes = new Set([
  "/api/connectors/jobs/next",
  "/api/connectors/jobs/:jobId/progress",
  "/api/connectors/jobs/:jobId/result",
  "/api/connectors/jobs/:jobId/failure",
  "/api/connectors/jobs/:jobId/resources",
  "/api/connectors/credentials",
  "/api/connectors/credentials/:connectorInstanceId",
  "/api/connectors/pairings",
  "/api/connectors/pairings/exchange",
  "/api/connectors/installations/:connectorInstanceId/status",
  "/api/connectors/bindings/:connectorBindingId/probe",
  "/api/connectors/bindings/:connectorBindingId/ready",
  "/api/connectors/session",
]);

export function registerConnectorTransportRoutes(
  app: FastifyInstance,
  dependencies: ConnectorTransportRouteDependencies,
): void {
  app.get("/api/connectors/session", async (request, reply) => {
    setPrivateNoStore(reply);
    return {
      connector: await dependencies.resolveConnectorPrincipal(request),
    };
  });

  if (dependencies.credentials && dependencies.authenticatedUserId) {
    if (dependencies.pairings) {
      app.post("/api/connectors/pairings", async (request, reply) => {
        setPrivateNoStore(reply);
        const authenticatedUserId = await dependencies.authenticatedUserId!(request);
        return reply.code(201).send({
          pairing: dependencies.pairings!.issue(authenticatedUserId),
        });
      });

      app.post(
        "/api/connectors/pairings/exchange",
        async (request, reply) => {
          setPrivateNoStore(reply);
          const { pairingCode } = pairingExchangeSchema.parse(request.body);
          const pairing = dependencies.pairings!.consume(pairingCode);
          await dependencies.relay.unregisterPrincipal(pairing);
          return reply.code(201).send({
            connector: await dependencies.credentials!.issue(
              pairing.authenticatedUserId,
              pairing.connectorInstanceId,
            ),
          });
        },
      );
    }

    app.post("/api/connectors/credentials", async (request, reply) => {
      setPrivateNoStore(reply);
      const authenticatedUserId = await dependencies.authenticatedUserId!(request);
      const body = credentialBodySchema.parse(request.body);
      await dependencies.relay.unregisterPrincipal({
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

    app.get(
      "/api/connectors/installations/:connectorInstanceId/status",
      async (request, reply) => {
        setPrivateNoStore(reply);
        const authenticatedUserId = await dependencies.authenticatedUserId!(request);
        const params = credentialParamsSchema.parse(request.params);
        const connector = await dependencies.credentials!.setupStatus(
            authenticatedUserId,
            params.connectorInstanceId,
          );
        return reply.send({
          connector: {
            ...connector,
            liveReady: dependencies.pairings?.isLive(
              authenticatedUserId,
              params.connectorInstanceId,
            ) ?? false,
          },
        });
      },
    );

    app.delete(
      "/api/connectors/credentials/:connectorInstanceId",
      async (request, reply) => {
        const authenticatedUserId = await dependencies.authenticatedUserId!(request);
        const params = credentialParamsSchema.parse(request.params);
        await dependencies.credentials!.revoke(
          authenticatedUserId,
          params.connectorInstanceId,
        );
        await dependencies.relay.unregisterPrincipal({
          authenticatedUserId,
          connectorInstanceId: params.connectorInstanceId,
        });
        dependencies.pairings?.clearLive(
          authenticatedUserId,
          params.connectorInstanceId,
        );
        return reply.code(204).send();
      },
    );
  }

  app.post(
    "/api/connectors/bindings/:connectorBindingId/probe",
    async (request, reply) => {
      setPrivateNoStore(reply);
      const principal = await dependencies.resolveConnectorPrincipal(request);
      const { connectorBindingId } = bindingParamsSchema.parse(request.params);
      const { provider } = probeBodySchema.parse(request.body);
      const githubRepositoryId = await ensureRegisteredRepository(
        dependencies,
        principal,
        connectorBindingId,
      );
      const result = await dependencies.relay.dispatch<{ message: string }>({
        jobId: randomUUID(),
        connectorBindingId,
        userId: principal.authenticatedUserId,
        githubRepositoryId,
        conversationId: `connector-probe:${connectorBindingId}`,
        provider,
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
      return reply.send({
        connected: true,
        provider,
        durationMs: result.durationMs,
      });
    },
  );

  app.post(
    "/api/connectors/bindings/:connectorBindingId/ready",
    async (request, reply) => {
      setPrivateNoStore(reply);
      const principal = await dependencies.resolveConnectorPrincipal(request);
      const { connectorBindingId } = bindingParamsSchema.parse(request.params);
      await ensureRegisteredRepository(dependencies, principal, connectorBindingId);
      dependencies.pairings?.markLive(
        principal.authenticatedUserId,
        principal.connectorInstanceId,
        connectorBindingId,
      );
      return reply.code(204).send();
    },
  );

  app.get("/api/connectors/jobs/next", async (request, reply) => {
    // A leased job contains owner-private prompt/context. Intermediaries must
    // never retain it, even though connector authentication is also required.
    setPrivateNoStore(reply);
    const principal = await dependencies.resolveConnectorPrincipal(request);
    const query = pollQuerySchema.parse(request.query);
    await ensureRegisteredRepository(
      dependencies,
      principal,
      query.connectorBindingId,
    );
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

  // The owning connector's answer to a resource batch. This body can carry
  // approved file content in flight, so it is never cached, never logged, and
  // never stored: it is validated and handed to the waiting caller.
  app.post("/api/connectors/jobs/:jobId/resources", async (request, reply) => {
    setPrivateNoStore(reply);
    const principal = await dependencies.resolveConnectorPrincipal(request);
    const { jobId: requestId } = jobParamsSchema.parse(request.params);
    const response = resourceExchangeResponseSchema.parse(request.body);
    return dependencies.relay.completeResourceExchange(principal, requestId, response)
      ? reply.code(204).send()
      : reply.code(409).send({ error: "Resource request is no longer active" });
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

async function ensureRegisteredRepository(
  dependencies: ConnectorTransportRouteDependencies,
  principal: Readonly<ConnectorPrincipal>,
  connectorBindingId: string,
): Promise<string> {
  try {
    return dependencies.relay.registeredRepository(principal, connectorBindingId);
  } catch (originalError) {
    if (!dependencies.credentials) throw originalError;
    const restored = await dependencies.credentials.restoreReadyBinding(
      principal,
      connectorBindingId,
    );
    if (!restored) throw originalError;
    dependencies.relay.registerBinding(
      principal,
      restored.connectorBindingId,
      restored.githubRepositoryId,
    );
    return restored.githubRepositoryId;
  }
}
