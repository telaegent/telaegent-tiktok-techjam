import type {
  ManagedAgentTurnRequest,
  ManagedAgentTurnResult,
  ProviderSessionManager,
  ProviderSessionScope,
} from "./provider-session-manager.js";
import {
  RuntimeProgressChannel,
  type RuntimeProgressEnvelope,
  type RuntimeProgressOwner,
  type RuntimeProgressSubscription,
} from "./runtime-progress-channel.js";

export interface StartedPrivateRuntimeTurn<T = unknown> {
  streamId: string;
  completion: Promise<ManagedAgentTurnResult<T>>;
}

/**
 * Connects a managed provider session to safe, owner-scoped realtime progress.
 *
 * This is deliberately transport- and persistence-neutral. The eventual HTTP
 * adapter must obtain the scope from an authenticated runtime binding; browser
 * input must never supply a workspace path or claim an owner scope directly.
 */
export class PrivateRuntimeTurnCoordinator {
  constructor(
    private readonly sessions: ProviderSessionManager,
    private readonly progress: RuntimeProgressChannel = new RuntimeProgressChannel(),
  ) {}

  start<T = unknown>(
    scope: ProviderSessionScope,
    request: ManagedAgentTurnRequest,
  ): StartedPrivateRuntimeTurn<T> {
    const owner = progressOwner(scope);
    const streamId = this.progress.open(owner);
    const completion = this.sessions
      .run<T>(scope, request, (event) => {
        this.progress.publish(streamId, event);
      })
      .catch((error: unknown) => {
        this.progress.publish(streamId, {
          type: "turn_failed",
          provider: scope.provider,
        });
        throw error;
      });
    return { streamId, completion };
  }

  subscribe(
    streamId: string,
    owner: RuntimeProgressOwner,
    listener: (event: RuntimeProgressEnvelope) => void,
  ): RuntimeProgressSubscription | null {
    return this.progress.subscribe(streamId, owner, listener);
  }

  close(streamId: string, owner: RuntimeProgressOwner): boolean {
    return this.progress.close(streamId, owner);
  }
}

function progressOwner(scope: ProviderSessionScope): RuntimeProgressOwner {
  return {
    userId: scope.userId,
    repositoryId: scope.repositoryId,
    conversationId: scope.conversationId,
  };
}
