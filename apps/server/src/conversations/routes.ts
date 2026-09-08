import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { isGitHubRepositoryId } from "../authorization/github-repository-id.js";
import { HttpError } from "../errors.js";
import { setPrivateNoStore } from "../http-cache.js";
import { DEFAULT_RUNTIME_EFFORT, RUNTIME_EFFORTS } from "../runtime-efforts.js";
import { DEFAULT_RUNTIME_MODEL, RUNTIME_MODELS } from "../runtime-models.js";
import type { AgentProvider } from "../runtime-contract.js";
import { humanClarificationAnswerSchema } from "../agent-clarification/contract.js";
import { PROTOCOL_LIMITS } from "../telagent/protocol/contract.js";
import type { ConversationService } from "./service.js";

const uuid = z.string().uuid();
const conversationParams = z.object({ conversationId: uuid });
const draftParams = z.object({ draftId: uuid });
const clarificationTaskParams = z.object({ taskId: uuid });
const sharedMessageParams = z.object({ messageId: uuid });
const repositoryId = z.string().refine(isGitHubRepositoryId, "Invalid GitHub repository ID");
const createDraftBody = z.strictObject({
  githubRepositoryId: repositoryId,
  provider: z.enum(["codex", "claude"]),
  roughMessage: z.string().trim().min(1).max(PROTOCOL_LIMITS.maxPrivateMessageChars),
});
const createReplyBody = z.strictObject({
  githubRepositoryId: repositoryId,
  provider: z.enum(["codex", "claude"]),
  incomingMessageId: uuid,
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  // Optional steering the owner adds on top of the incoming message.
  ownerGuidance: z
    .string()
    .trim()
    .min(1)
    .max(PROTOCOL_LIMITS.maxPrivateMessageChars)
    .optional(),
  allowAgentClarification: z.boolean().optional(),
  dialogueModel: z.string().trim().min(1).max(64).optional(),
});
const emptyBody = z.strictObject({}).optional();
// A run may name a model and an effort. Only the shape of `model` is checked
// here -- whether this provider has it is checked in the service, the layer
// that knows the draft's provider -- while `effort` is checked outright,
// because the rungs are the same whichever provider the draft names. Absent
// means "do not choose" for both, which is also what an older client sends:
// the endpoint's previous body was `{}`.
const runBody = z
  .strictObject({
    model: z.string().trim().min(1).max(64).optional(),
    effort: z.enum(RUNTIME_EFFORTS).optional(),
  })
  .optional();
const clarificationBody = z.strictObject({
  content: z.string().trim().min(1).max(PROTOCOL_LIMITS.maxPrivateMessageChars),
});
const sendBody = z.strictObject({
  approvedContent: z.string().trim().min(1).max(50_000).optional(),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  allowAgentClarification: z.boolean().optional(),
  dialogueModel: z.string().trim().min(1).max(64).optional(),
});
const continueAgentClarificationBody = z.strictObject({
  currentStepId: uuid,
  expectedVersion: z.number().int().min(0),
  answer: humanClarificationAnswerSchema,
});
const messageQuery = z.object({
  githubRepositoryId: repositoryId,
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
});
const draftListQuery = z.strictObject({ githubRepositoryId: repositoryId });
const runtimeModelsQuery = z.strictObject({ githubRepositoryId: repositoryId });

export type AuthenticatedUserResolver = (
  request: FastifyRequest,
) => string | Promise<string>;

export interface ConversationRouteDependencies {
  service: ConversationService;
  authenticatedUserId: AuthenticatedUserResolver;
  availableProviders?: (
    authenticatedUserId: string,
    githubRepositoryId: string,
  ) => readonly AgentProvider[];
  agentClarificationEnabled?: boolean | undefined;
}

export function registerConversationRoutes(
  app: FastifyInstance,
  dependencies: ConversationRouteDependencies,
): void {
  const user = async (request: FastifyRequest): Promise<string> => {
    const userId = await dependencies.authenticatedUserId(request);
    if (!uuid.safeParse(userId).success) throw new HttpError(401, "Authentication required");
    return userId;
  };

  // What the pickers can offer. Behind the same authentication as the rest of
  // the surface -- it leaks nothing, but an unauthenticated endpoint that
  // exists for one logged-in screen is a surface with no reason to be one.
  //
  // Models are per provider and efforts are not, and the shape says so: a
  // caller reads `efforts` once and reuses it for every draft, rather than
  // looking up a list that would be identical under each provider.
  app.get("/api/runtime/models", async (request, reply) => {
    setPrivateNoStore(reply);
    const authenticatedUserId = await user(request);
    const { githubRepositoryId } = runtimeModelsQuery.parse(request.query);
    const available = dependencies.availableProviders
      ? new Set(
          dependencies.availableProviders(authenticatedUserId, githubRepositoryId),
        )
      : new Set(Object.keys(RUNTIME_MODELS) as AgentProvider[]);
    return {
      providers: (Object.keys(RUNTIME_MODELS) as AgentProvider[])
        .filter((provider) => available.has(provider))
        .map((provider) => ({
          provider,
          models: [...RUNTIME_MODELS[provider]],
          defaultModel: DEFAULT_RUNTIME_MODEL[provider],
        })),
      efforts: [...RUNTIME_EFFORTS],
      defaultEffort: DEFAULT_RUNTIME_EFFORT,
      agentClarificationEnabled:
        dependencies.agentClarificationEnabled === true,
    };
  });

  app.post("/api/conversations/:conversationId/drafts", async (request, reply) => {
    setPrivateNoStore(reply);
    const { conversationId } = conversationParams.parse(request.params);
    const body = createDraftBody.parse(request.body);
    const draft = await dependencies.service.createDraft({
      authenticatedUserId: await user(request),
      conversationId,
      ...body,
    });
    return reply.code(201).send({ draft });
  });

  // Opens a private draft answering a collaborator's approved message. The
  // reply it produces is owner-private until it leaves through /send, exactly
  // like a sender draft.
  app.post("/api/conversations/:conversationId/replies", async (request, reply) => {
    setPrivateNoStore(reply);
    const { conversationId } = conversationParams.parse(request.params);
    const body = createReplyBody.parse(request.body);
    const result = await dependencies.service.createRecipientDraft({
      authenticatedUserId: await user(request),
      conversationId,
      ...body,
    });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.get("/api/drafts/:draftId", async (request, reply) => {
    setPrivateNoStore(reply);
    const { draftId } = draftParams.parse(request.params);
    return { draft: await dependencies.service.getDraft(await user(request), draftId) };
  });

  app.get("/api/conversations/:conversationId/drafts", async (request, reply) => {
    setPrivateNoStore(reply);
    const { conversationId } = conversationParams.parse(request.params);
    const query = draftListQuery.parse(request.query);
    return {
      drafts: await dependencies.service.listRecoverableDrafts({
        authenticatedUserId: await user(request),
        conversationId,
        ...query,
      }),
    };
  });

  app.post("/api/drafts/:draftId/run", async (request, reply) => {
    setPrivateNoStore(reply);
    const { draftId } = draftParams.parse(request.params);
    const body = runBody.parse(request.body);
    const draft = await dependencies.service.runDraft(await user(request), draftId, {
      ...(body?.model ? { model: body.model } : {}),
      ...(body?.effort ? { effort: body.effort } : {}),
    });
    return reply.code(202).send({ draft, pollUrl: `/api/drafts/${draft.draftId}` });
  });

  app.post("/api/drafts/:draftId/messages", async (request, reply) => {
    setPrivateNoStore(reply);
    const { draftId } = draftParams.parse(request.params);
    const body = clarificationBody.parse(request.body);
    return {
      draft: await dependencies.service.addClarification({
        authenticatedUserId: await user(request),
        draftId,
        content: body.content,
      }),
    };
  });

  app.post("/api/drafts/:draftId/cancel", async (request, reply) => {
    setPrivateNoStore(reply);
    const { draftId } = draftParams.parse(request.params);
    emptyBody.parse(request.body);
    return { draft: await dependencies.service.cancelDraft(await user(request), draftId) };
  });

  app.post("/api/drafts/:draftId/send", async (request, reply) => {
    setPrivateNoStore(reply);
    const { draftId } = draftParams.parse(request.params);
    const body = sendBody.parse(request.body);
    const result = await dependencies.service.sendDraft({
      authenticatedUserId: await user(request),
      draftId,
      ...body,
    });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.get("/api/drafts/:draftId/agent-clarification", async (request, reply) => {
    setPrivateNoStore(reply);
    const { draftId } = draftParams.parse(request.params);
    return {
      task: await dependencies.service.getAgentClarification(
        await user(request),
        draftId,
      ),
    };
  });

  app.get(
    "/api/conversations/:conversationId/agent-clarifications",
    async (request, reply) => {
      setPrivateNoStore(reply);
      const { conversationId } = conversationParams.parse(request.params);
      const query = draftListQuery.parse(request.query);
      return {
        tasks: await dependencies.service.listAgentClarifications({
          authenticatedUserId: await user(request),
          conversationId,
          ...query,
        }),
      };
    },
  );

  app.post(
    "/api/agent-clarifications/:taskId/continue",
    async (request, reply) => {
      setPrivateNoStore(reply);
      const { taskId } = clarificationTaskParams.parse(request.params);
      const body = continueAgentClarificationBody.parse(request.body);
      return {
        task: await dependencies.service.continueAgentClarificationTask({
          authenticatedUserId: await user(request),
          taskId,
          ...body,
        }),
      };
    },
  );

  app.post(
    "/api/agent-clarifications/:taskId/stop",
    async (request, reply) => {
      setPrivateNoStore(reply);
      const { taskId } = clarificationTaskParams.parse(request.params);
      emptyBody.parse(request.body);
      await dependencies.service.stopAgentClarificationTask(
        await user(request),
        taskId,
      );
      return reply.code(204).send();
    },
  );

  // Keyed by the message rather than by a task, because the whole point is the
  // window before a task exists: consent is written by `Send`, and the
  // recipient's agent may not pick it up for another hour.
  app.post(
    "/api/shared-messages/:messageId/agent-clarification-consent/revoke",
    async (request, reply) => {
      setPrivateNoStore(reply);
      const { messageId } = sharedMessageParams.parse(request.params);
      emptyBody.parse(request.body);
      await dependencies.service.revokeAgentClarificationConsent(
        await user(request),
        messageId,
      );
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/drafts/:draftId/agent-clarification/continue",
    async (request, reply) => {
      setPrivateNoStore(reply);
      const { draftId } = draftParams.parse(request.params);
      const body = continueAgentClarificationBody.parse(request.body);
      return {
        task: await dependencies.service.continueAgentClarification({
          authenticatedUserId: await user(request),
          draftId,
          ...body,
        }),
      };
    },
  );

  app.post(
    "/api/drafts/:draftId/agent-clarification/stop",
    async (request, reply) => {
      setPrivateNoStore(reply);
      const { draftId } = draftParams.parse(request.params);
      emptyBody.parse(request.body);
      await dependencies.service.stopAgentClarification(
        await user(request),
        draftId,
      );
      return reply.code(204).send();
    },
  );

  app.get("/api/conversations/:conversationId/messages", async (request, reply) => {
    setPrivateNoStore(reply);
    const { conversationId } = conversationParams.parse(request.params);
    const query = messageQuery.parse(request.query);
    // The page carries its own next cursor, so the response shape is the page.
    // `messages` keeps its name and meaning for existing readers.
    return await dependencies.service.listMessages({
      authenticatedUserId: await user(request),
      conversationId,
      ...query,
    });
  });
}
