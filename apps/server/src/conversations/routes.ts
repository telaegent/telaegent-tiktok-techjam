import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { isGitHubRepositoryId } from "../authorization/github-repository-id.js";
import { HttpError } from "../errors.js";
import { setPrivateNoStore } from "../http-cache.js";
import { PROTOCOL_LIMITS } from "../telagent/protocol/contract.js";
import type { ConversationService } from "./service.js";

const uuid = z.string().uuid();
const conversationParams = z.object({ conversationId: uuid });
const draftParams = z.object({ draftId: uuid });
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
  // Optional steering the owner adds on top of the incoming message.
  ownerGuidance: z
    .string()
    .trim()
    .min(1)
    .max(PROTOCOL_LIMITS.maxPrivateMessageChars)
    .optional(),
});
const emptyBody = z.strictObject({}).optional();
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
});
const messageQuery = z.object({ githubRepositoryId: repositoryId });

export type AuthenticatedUserResolver = (
  request: FastifyRequest,
) => string | Promise<string>;

export interface ConversationRouteDependencies {
  service: ConversationService;
  authenticatedUserId: AuthenticatedUserResolver;
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
    const draft = await dependencies.service.createRecipientDraft({
      authenticatedUserId: await user(request),
      conversationId,
      ...body,
    });
    return reply.code(201).send({ draft });
  });

  app.get("/api/drafts/:draftId", async (request, reply) => {
    setPrivateNoStore(reply);
    const { draftId } = draftParams.parse(request.params);
    return { draft: await dependencies.service.getDraft(await user(request), draftId) };
  });

  app.post("/api/drafts/:draftId/run", async (request, reply) => {
    setPrivateNoStore(reply);
    const { draftId } = draftParams.parse(request.params);
    emptyBody.parse(request.body);
    const draft = await dependencies.service.runDraft(await user(request), draftId);
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

  app.get("/api/conversations/:conversationId/messages", async (request, reply) => {
    setPrivateNoStore(reply);
    const { conversationId } = conversationParams.parse(request.params);
    const query = messageQuery.parse(request.query);
    return {
      messages: await dependencies.service.listMessages({
        authenticatedUserId: await user(request),
        conversationId,
        ...query,
      }),
    };
  });
}
