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
    expect(providerRun).toHaveBeenCalledOnce();
  });
});

class RelayWorkerTransport implements ConnectorWorkerTransport {
  constructor(
    private readonly relay: LongPollConnectorJobRelay,
    private readonly principal: typeof principal,
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
