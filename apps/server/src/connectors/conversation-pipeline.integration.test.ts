import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PrivateRuntimeAuthorizer } from "../authorization/private-runtime-authorization.js";
import { AuthorizedConversationAccess } from "../conversations/conversation-api-factory.js";
import { AuthorizedProtocolDraftRuntime } from "../conversations/authorized-runtime-adapter.js";
import { InMemoryConversationRepository } from "../conversations/in-memory-repository.js";
import { ConversationService } from "../conversations/service.js";
import {
  InMemoryProviderSessionStore,
  ProviderSessionManager,
} from "../provider-session-manager.js";
import type { RuntimeProgressEvent } from "../runtime-contract.js";
import { createAuthorizedProtocolTurnRuntime } from "../telagent/protocol/authorized-turn-service.js";
import {
  ConnectorWorker,
  type ConnectorWorkerTransport,
} from "./connector-worker.js";
import type { ConnectorJobResult } from "./connector-turn-executor.js";
import {
  LongPollConnectorJobRelay,
  type ConnectorDelivery,
} from "./long-poll-job-relay.js";

const principal = {
  authenticatedUserId: "10000000-0000-4000-8000-000000000001",
  connectorInstanceId: "connector_instance_0001",
};
const repositoryId = "9223372036854775807";
const conversationId = "70000000-0000-4000-8000-000000000007";
const bindingId = "50000000-0000-4000-8000-000000000005";
const recipientPrincipal = {
  authenticatedUserId: "20000000-0000-4000-8000-000000000002",
  connectorInstanceId: "connector_instance_0002",
};
const recipientBindingId = "60000000-0000-4000-8000-000000000006";

describe("conversation -> cloud relay -> local connector pipeline", () => {
  it("returns a private candidate and shares it only after the human Send", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, repositoryId);
    const repository = new InMemoryConversationRepository();
    const authorizer: PrivateRuntimeAuthorizer = {
      async authorizePrivateRuntime() {
        return {
          userId: principal.authenticatedUserId,
          githubRepositoryId: repositoryId,
          runtimeBindingId: bindingId,
        };
      },
    };
    const contextLoader = vi.fn(async (_scope, request: { correlationId: string }) => {
      const draft = await repository.getDraft(request.correlationId);
      if (!draft) return null;
      return {
        role: "sender" as const,
        facts: {
          repositoryFullName: "Telaegent/secret",
          githubRepositoryId: repositoryId,
          branch: "main",
          commit: "a".repeat(40),
          ownerName: "Phuong",
          collaboratorName: "Justin",
        },
        sharedHistory: [],
        projectFacts: ["Repository: Telaegent/secret"],
        privateTurns: draft.privateTurns,
        ownerInput: draft.roughMessage,
      };
    });
    const cloudRuntime = createAuthorizedProtocolTurnRuntime({
      authorizer,
      loadContext: contextLoader,
      connector: relay,
      policy: {
        maxTurns: 2,
        maximumRuntimePromptBytes: 1_048_576,
        maximumPersistedSummaryBytes: 524_288,
      },
    });
    const service = new ConversationService(
      repository,
      new AuthorizedConversationAccess(authorizer),
      new AuthorizedProtocolDraftRuntime(cloudRuntime.turns, cloudRuntime.coordinator),
      { createId: sequentialUuid() },
    );

    const providerRun = vi.fn(async (request, onProgress?: (event: RuntimeProgressEvent) => void) => {
      expect(request.workspacePath).toBe(path.resolve("."));
      expect(request.sandboxMode).toBe("read-only");
      expect(request.networkMode).toBe("none");
      onProgress?.({ type: "turn_started", provider: "claude" });
      return {
        provider: "claude" as const,
        final: {
          state: "ready",
          assistantMessage: "I prepared a concise reply.",
          sendCandidate: "The connector pipeline is working.",
          riskFlags: [],
          referencedPaths: [],
        },
        changedFiles: [],
        exitCode: 0,
        durationMs: 20,
      };
    });
    const sessions = new ProviderSessionManager(
      { run: providerRun },
      new InMemoryProviderSessionStore(),
      async (_scope, request) => request,
    );
    const transport = new RelayWorkerTransport(relay, principal, bindingId);
    const worker = new ConnectorWorker(
      {
        connectorBindingId: bindingId,
        authenticatedUserId: principal.authenticatedUserId,
        githubRepositoryId: repositoryId,
        workspacePath: ".",
      },
      sessions,
      transport,
      { cancel: async () => false },
    );

    const draft = await service.createDraft({
      authenticatedUserId: principal.authenticatedUserId,
      githubRepositoryId: repositoryId,
      conversationId,
      provider: "claude",
      roughMessage: "Tell Justin the pipeline works",
    });
    await service.runDraft(principal.authenticatedUserId, draft.draftId);
    await expect(worker.runOnce()).resolves.toBe("completed");

    await vi.waitFor(async () => {
      const prepared = await service.getDraft(
        principal.authenticatedUserId,
        draft.draftId,
      );
      expect(prepared.state).toBe("ready");
      expect(prepared.sendCandidate).toBe("The connector pipeline is working.");
    });
    expect(await repository.listMessages(conversationId)).toEqual([]);

    const sent = await service.sendDraft({
      authenticatedUserId: principal.authenticatedUserId,
      draftId: draft.draftId,
      idempotencyKey: "send-1",
    });
    expect(sent.message.body).toBe("The connector pipeline is working.");
    expect(await repository.listMessages(conversationId)).toHaveLength(1);
    // One connector job, two local provider passes: research then draft.
    expect(providerRun).toHaveBeenCalledTimes(2);
    expect(providerRun.mock.calls[0]?.[0].outputSchemaName).toBe(
      "investigation-note.schema.json",
    );
    expect(providerRun.mock.calls[1]?.[0].outputSchemaName).toBe(
      "sender-turn.schema.json",
    );
  });

  it("completes the recipient turn through its own connector and human Send gate", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, repositoryId);
    relay.registerBinding(recipientPrincipal, recipientBindingId, repositoryId);
    const repository = new InMemoryConversationRepository();
    const bindings = new Map([
      [principal.authenticatedUserId, bindingId],
      [recipientPrincipal.authenticatedUserId, recipientBindingId],
    ]);
    const authorizer: PrivateRuntimeAuthorizer = {
      async authorizePrivateRuntime(input) {
        const ownedBinding = bindings.get(input.authenticatedUserId);
        if (!ownedBinding) throw new Error("Test principal has no connector binding");
        return {
          userId: input.authenticatedUserId,
          githubRepositoryId: repositoryId,
          runtimeBindingId: ownedBinding,
        };
      },
    };
    const contextLoader = vi.fn(async (scope, request: { correlationId: string }) => {
      const draft = await repository.getDraft(request.correlationId);
      if (!draft) return null;
      const ownerIsSender = scope.userId === principal.authenticatedUserId;
      const facts = {
        repositoryFullName: "Telaegent/round-trip",
        githubRepositoryId: repositoryId,
        branch: ownerIsSender ? "feat/request" : "feat/answer",
        commit: ownerIsSender ? "a".repeat(40) : "b".repeat(40),
        ownerName: ownerIsSender ? "Phuong" : "Justin",
        collaboratorName: ownerIsSender ? "Justin" : "Phuong",
      };
      if (draft.role === "sender") {
        return {
          role: "sender" as const,
          facts,
          sharedHistory: [],
          projectFacts: ["Repository: Telaegent/round-trip"],
          privateTurns: draft.privateTurns,
          ownerInput: draft.roughMessage ?? "",
        };
      }
      const messages = await repository.listMessages(draft.conversationId);
      const incoming = messages.find(
        (message) => message.messageId === draft.incomingMessageId,
      );
      if (!incoming) return null;
      return {
        role: "recipient" as const,
        facts,
        sharedHistory: [],
        projectFacts: ["Repository: Telaegent/round-trip"],
        privateTurns: draft.privateTurns,
        incomingMessage: incoming.body,
      };
    });
    const cloudRuntime = createAuthorizedProtocolTurnRuntime({
      authorizer,
      loadContext: contextLoader,
      connector: relay,
      policy: {
        maxTurns: 2,
        maximumRuntimePromptBytes: 1_048_576,
        maximumPersistedSummaryBytes: 524_288,
      },
    });
    const service = new ConversationService(
      repository,
      new AuthorizedConversationAccess(authorizer),
      new AuthorizedProtocolDraftRuntime(cloudRuntime.turns, cloudRuntime.coordinator),
      { createId: sequentialUuid() },
    );

    const senderProviderRun = vi.fn(async () => ({
      provider: "claude" as const,
      final: {
        state: "ready" as const,
        assistantMessage: "Prepared the repository question.",
        sendCandidate: "Where is refresh-token rotation enforced?",
        riskFlags: [],
        referencedPaths: [],
      },
      changedFiles: [],
      exitCode: 0,
      durationMs: 10,
    }));
    const recipientProviderRun = vi.fn(async (request) => {
      expect(request.purpose).toBe("recipient_answer");
      expect(request.outputSchemaName).toBe("recipient-turn.schema.json");
      expect(request.workspacePath).toBe(path.resolve("recipient-workspace"));
      expect(request.runtimePrompt).toContain("Where is refresh-token rotation enforced?");
      expect(request.runtimePrompt).toContain("Focus on the server-side check.");
      return {
        provider: "codex" as const,
        final: {
          state: "ready" as const,
          privateSummary: "Inspected the recipient's registered checkout.",
          sendCandidate: "Rotation is enforced in src/auth/session.ts before reuse.",
          riskFlags: [],
          sourcePaths: ["src/auth/session.ts"],
        },
        changedFiles: [],
        exitCode: 0,
        durationMs: 15,
      };
    });
    const senderSessions = new ProviderSessionManager(
      { run: senderProviderRun },
      new InMemoryProviderSessionStore(),
      async (_scope, request) => request,
    );
    const recipientSessions = new ProviderSessionManager(
      { run: recipientProviderRun },
      new InMemoryProviderSessionStore(),
      async (_scope, request) => request,
    );
    const senderWorker = new ConnectorWorker(
      {
        connectorBindingId: bindingId,
        authenticatedUserId: principal.authenticatedUserId,
        githubRepositoryId: repositoryId,
        workspacePath: "sender-workspace",
      },
      senderSessions,
      new RelayWorkerTransport(relay, principal, bindingId),
      { cancel: async () => false },
    );
    const recipientWorker = new ConnectorWorker(
      {
        connectorBindingId: recipientBindingId,
        authenticatedUserId: recipientPrincipal.authenticatedUserId,
        githubRepositoryId: repositoryId,
        workspacePath: "recipient-workspace",
      },
      recipientSessions,
      new RelayWorkerTransport(relay, recipientPrincipal, recipientBindingId),
      { cancel: async () => false },
    );

    const senderDraft = await service.createDraft({
      authenticatedUserId: principal.authenticatedUserId,
      githubRepositoryId: repositoryId,
      conversationId,
      provider: "claude",
      roughMessage: "Ask Justin where rotation is enforced",
    });
    await service.runDraft(principal.authenticatedUserId, senderDraft.draftId);
    await expect(senderWorker.runOnce()).resolves.toBe("completed");
    await vi.waitFor(async () => {
      expect((await service.getDraft(principal.authenticatedUserId, senderDraft.draftId)).state)
        .toBe("ready");
    });
    const question = await service.sendDraft({
      authenticatedUserId: principal.authenticatedUserId,
      draftId: senderDraft.draftId,
      idempotencyKey: "send-question",
    });

    const reply = await service.createRecipientDraft({
      authenticatedUserId: recipientPrincipal.authenticatedUserId,
      githubRepositoryId: repositoryId,
      conversationId,
      provider: "codex",
      incomingMessageId: question.message.messageId,
      ownerGuidance: "Focus on the server-side check.",
      idempotencyKey: "reply-question-1",
    });
    expect(reply.replayed).toBe(false);
    expect(reply.draft.privateTurns).toEqual([
      { speaker: "owner", text: "Focus on the server-side check." },
    ]);
    expect(await repository.listMessages(conversationId)).toHaveLength(1);

    await service.runDraft(recipientPrincipal.authenticatedUserId, reply.draft.draftId);
    await expect(recipientWorker.runOnce()).resolves.toBe("completed");
    await vi.waitFor(async () => {
      expect((await service.getDraft(
        recipientPrincipal.authenticatedUserId,
        reply.draft.draftId,
      )).state).toBe("ready");
    });
    expect(await repository.listMessages(conversationId)).toHaveLength(1);

    const answer = await service.sendDraft({
      authenticatedUserId: recipientPrincipal.authenticatedUserId,
      draftId: reply.draft.draftId,
      idempotencyKey: "send-answer",
    });
    expect(answer.message.body).toBe(
      "Rotation is enforced in src/auth/session.ts before reuse.",
    );
    expect(await repository.listMessages(conversationId)).toHaveLength(2);
    // Each side runs its own two-pass private turn, and only its own.
    expect(senderProviderRun).toHaveBeenCalledTimes(2);
    expect(recipientProviderRun).toHaveBeenCalledTimes(2);
  });
});

class RelayWorkerTransport implements ConnectorWorkerTransport {
  constructor(
    private readonly relay: LongPollConnectorJobRelay,
    private readonly principal: {
      authenticatedUserId: string;
      connectorInstanceId: string;
    },
    private readonly bindingId: string,
  ) {}

  async poll(signal?: AbortSignal): Promise<ConnectorDelivery | null> {
    if (!signal) return this.relay.poll(this.principal, this.bindingId, 0);
    return await new Promise((resolve) => {
      if (signal.aborted) return resolve(null);
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
  }

  async progress(jobId: string, event: RuntimeProgressEvent): Promise<void> {
    this.relay.publishProgress(this.principal, jobId, event);
  }

  async result(jobId: string, result: ConnectorJobResult): Promise<void> {
    this.relay.complete(this.principal, jobId, result);
  }

  async resourceResponse(): Promise<void> {
    throw new Error("This pipeline test does not serve resource requests");
  }

  async authorizeResourceRead(): Promise<boolean> {
    throw new Error("This pipeline test does not serve resource requests");
  }

  async failure(jobId: string, code: string): Promise<void> {
    this.relay.fail(
      this.principal,
      jobId,
      code as Parameters<LongPollConnectorJobRelay["fail"]>[2],
    );
  }
}

function sequentialUuid(): () => string {
  let value = 1;
  return () => `0000000${value++}-0000-4000-8000-000000000000`;
}
