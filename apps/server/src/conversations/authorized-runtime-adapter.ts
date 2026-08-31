import type { PrivateRuntimeTurnCoordinator } from "../private-runtime-turn-coordinator.js";
import type { AuthorizedProtocolTurnService } from "../telagent/protocol/authorized-turn-service.js";
import type { PrivateDraftTurnRuntime } from "./service.js";

/** Joins the canonical messaging lifecycle to the already-authorized runtime seam. */
export class AuthorizedProtocolDraftRuntime implements PrivateDraftTurnRuntime {
  constructor(
    private readonly turns: AuthorizedProtocolTurnService,
    private readonly coordinator: PrivateRuntimeTurnCoordinator,
  ) {}

  start<T = unknown>(input: Parameters<PrivateDraftTurnRuntime["start"]>[0]) {
    return this.turns.start<T>(input);
  }

  cancel(input: Parameters<PrivateDraftTurnRuntime["cancel"]>[0]): Promise<boolean> {
    return this.coordinator.cancel(input.turnId, {
      userId: input.authenticatedUserId,
      githubRepositoryId: input.githubRepositoryId,
      conversationId: input.conversationId,
    });
  }
}
