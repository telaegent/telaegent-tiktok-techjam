import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import { PrivateRuntimeAuthorizationError } from "./authorization/private-runtime-authorization.js";
import {
  RuntimeProviderError,
  normalizeRuntimeFailure,
} from "./runtime-errors.js";
import { registerTelagentRoutes } from "./telagent/routes.js";
import type { TelagentService } from "./telagent/service.js";
import {
  registerConversationRoutes,
  type ConversationRouteDependencies,
} from "./conversations/routes.js";
import { MessagePolicyError } from "./conversations/service.js";
import { UserAuthenticationError } from "./authentication/types.js";
import {
  registerIdentityRoutes,
  type IdentityRouteDependencies,
} from "./authentication/routes.js";
import {
  connectorAuthenticatedRepositoryProofRoutes,
  registerRepositoryProofRoutes,
  type RepositoryProofRouteDependencies,
} from "./repository-proof/routes.js";
import { RepositoryProofError } from "./repository-proof/service.js";
import {
  connectorTransportRoutes,
  registerConnectorTransportRoutes,
  type ConnectorTransportRouteDependencies,
} from "./connectors/routes.js";
import {
  registerProjectRoutes,
  userAuthenticatedProjectRoutes,
  type ProjectRouteDependencies,
} from "./projects/routes.js";
import {
  registerCapabilityScopeRoutes,
  userAuthenticatedCapabilityRoutes,
  type CapabilityScopeRouteDependencies,
} from "./capability/routes.js";
import { setPrivateNoStore } from "./http-cache.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const providerParams = z.object({
  id: z.string().uuid(),
  provider: z.enum(["codex", "claude"]),
});
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const userAuthenticatedConversationRoutes = new Set([
  "/api/conversations/:conversationId/drafts",
  "/api/conversations/:conversationId/replies",
  "/api/conversations/:conversationId/messages",
  "/api/drafts/:draftId",
  "/api/drafts/:draftId/run",
  "/api/drafts/:draftId/messages",
  "/api/drafts/:draftId/cancel",
  "/api/drafts/:draftId/send",
]);

export async function createApp(
  config: AppConfig,
  service: AgentService | undefined,
  telagentService?: TelagentService,
  conversationApi?: ConversationRouteDependencies,
  identityApi?: IdentityRouteDependencies,
  repositoryProofApi?: RepositoryProofRouteDependencies,
  connectorTransportApi?: ConnectorTransportRouteDependencies,
  projectApi?: ProjectRouteDependencies,
  capabilityScopeApi?: CapabilityScopeRouteDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
      serializers: {
        // OAuth callbacks carry a short-lived authorization code and state in
        // the query string. Keep request-path observability without ever
        // placing those values (or future cursor/search values) in logs.
        req(request) {
          return {
            method: request.method,
            url: request.url.split("?", 1)[0] ?? request.url,
          };
        },
      },
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    const requestPath = request.url.split("?", 1)[0] ?? request.url;
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      requestPath === "/api/auth" ||
      requestPath.startsWith("/api/auth/") ||
      (conversationApi &&
        userAuthenticatedConversationRoutes.has(
          request.routeOptions.url ?? "",
        )) ||
      (repositoryProofApi &&
        connectorAuthenticatedRepositoryProofRoutes.has(
          request.routeOptions.url ?? "",
        )) ||
      (connectorTransportApi &&
        connectorTransportRoutes.has(request.routeOptions.url ?? "")) ||
      (projectApi &&
        userAuthenticatedProjectRoutes.has(request.routeOptions.url ?? "")) ||
      (capabilityScopeApi &&
        userAuthenticatedCapabilityRoutes.has(request.routeOptions.url ?? ""))
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "telaegent-control-plane",
  }));

  app.get("/api/auth", async () => ({
    required: identityApi ? true : config.authToken.length > 0,
    provider: identityApi ? "github" : "disabled",
  }));

  if (identityApi) {
    registerIdentityRoutes(app, identityApi);
  } else {
    app.get("/api/auth/session", async (_request, reply) => {
      setPrivateNoStore(reply);
      return {
        enabled: false,
        authenticated: false,
      };
    });
  }

  if (service) {
    registerLegacyPlaygroundRoutes(app, service);
  }

  if (telagentService) {
    registerTelagentRoutes(app, telagentService);
  }
  if (conversationApi) {
    registerConversationRoutes(app, conversationApi);
  }
  if (repositoryProofApi) {
    registerRepositoryProofRoutes(app, repositoryProofApi);
  }
  if (connectorTransportApi) {
    registerConnectorTransportRoutes(app, connectorTransportApi);
  }
  if (projectApi) {
    registerProjectRoutes(app, projectApi);
  }
  if (capabilityScopeApi) {
    registerCapabilityScopeRoutes(app, capabilityScopeApi);
  }

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const runtimeError =
      error instanceof RuntimeProviderError || error instanceof RunCancelledError
        ? normalizeRuntimeFailure(error)
        : null;
    const policyError = error instanceof MessagePolicyError ? error : null;
    const authorizationError =
      error instanceof PrivateRuntimeAuthorizationError ? error : null;
    const authenticationError =
      error instanceof UserAuthenticationError ? error : null;
    const repositoryProofError =
      error instanceof RepositoryProofError ? error : null;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      runtimeError
        ? runtimeError.statusCode
        : authenticationError
          ? authenticationError.statusCode
          : repositoryProofError
            ? repositoryProofError.statusCode
            : policyError
              ? 422
              : authorizationError
                ? authorizationError.code === "PRIVATE_RUNTIME_FORBIDDEN"
                  ? 403
                  : 503
                : error instanceof HttpError
                  ? error.statusCode
                  : validationError
                    ? 400
                    : frameworkStatus &&
                        frameworkStatus >= 400 &&
                        frameworkStatus <= 599
                      ? frameworkStatus
                      : 500;
    if (statusCode >= 500) {
      request.log.error(
        {
          errorName: appError.name,
          ...(runtimeError ? { runtimeCode: runtimeError.code } : {}),
        },
        "Request failed",
      );
    }
    return reply.code(statusCode).send({
      error:
        runtimeError?.message ??
        authenticationError?.message ??
        repositoryProofError?.message ??
        authorizationError?.message ??
        (statusCode >= 500 ? "Internal server error" : appError.message),
      ...(runtimeError
        ? { code: runtimeError.code, retryable: runtimeError.retryable }
        : {}),
      ...(authenticationError
        ? { code: authenticationError.code, retryable: authenticationError.retryable }
        : {}),
      ...(repositoryProofError ? { code: repositoryProofError.code } : {}),
      ...(policyError ? { findings: policyError.findings } : {}),
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}

// Inherited Starter Kit Playground. It drives a provider runner and a local
// workspace, so it is only mounted when ENABLE_LEGACY_LOCAL_PLAYGROUND is set;
// the canonical control plane runs without it.
function registerLegacyPlaygroundRoutes(
  app: FastifyInstance,
  service: AgentService,
): void {
  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.get("/api/agents/:id/providers", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { connections: await service.providerConnectionStatuses(id) };
  });

  app.post("/api/agents/:id/providers/:provider/probe", async (request) => {
    const { id, provider } = providerParams.parse(request.params);
    return {
      connection: await service.probeProviderConnection(
        id,
        provider,
        request.id,
      ),
    };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });
}
