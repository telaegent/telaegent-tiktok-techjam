import { createConfiguredAuthorizationRepository } from "../authorization/authorization-repository-factory.js";
import {
  PrivateRuntimeAuthorizationService,
  type PrivateRuntimeAuthorizer,
} from "../authorization/private-runtime-authorization.js";
import type { PrivateDraftFollowUp } from "../capability/draft-follow-up.js";
import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import type { StartedPrivateRuntimeTurn } from "../private-runtime-turn-coordinator.js";
import { RuntimeProviderError } from "../runtime-errors.js";
import { createConfiguredConversationRepository } from "./conversation-repository-factory.js";
import type { ConversationRepository } from "./repository.js";
import type {
  AuthenticatedUserResolver,
  ConversationRouteDependencies,
} from "./routes.js";
import {
  ConversationService,
  type ConversationAccessAuthorizer,
  type PrivateDraftTurnRuntime,
} from "./service.js";

/** Repository access proof older than this must be re-verified before a turn. */
const repositoryAccessMaxAgeMs = 900_000;
/** Authorization snapshot read deadline. */
const repositoryReadTimeoutMs = 5_000;

/**
 * Product authorization for one conversation action.
 *
 * Every action re-authorizes from scratch. Repository access, membership,
 * project connections, and runtime bindings are all revocable mid-conversation,
 * so no decision may be cached across actions.
 *
 * This is deliberately strict: `authorizePrivateRuntime` also requires a ready
 * runtime binding, so a read is refused while the owner's connector is
 * detached. Loosening read actions is a product decision, not a wiring one.
 */
export class AuthorizedConversationAccess implements ConversationAccessAuthorizer {
  constructor(private readonly authorizer: PrivateRuntimeAuthorizer) {}

  async authorize(
    input: Parameters<ConversationAccessAuthorizer["authorize"]>[0],
  ): Promise<void> {
    await this.authorizer.authorizePrivateRuntime({
      authenticatedUserId: input.authenticatedUserId,
      githubRepositoryId: input.githubRepositoryId,
      conversationId: input.conversationId,
    });
  }
}

/**
 * Fail-closed fallback when the cloud-to-local transport is not configured.
 *
 * Production composition supplies the long-poll connector relay only when the
 * durable authorization and protocol-context stores are enabled. Other modes
 * fail closed rather than silently running a provider inside the cloud.
 */
export class ConnectorUnavailableDraftRuntime implements PrivateDraftTurnRuntime {
  async start<T = unknown>(): Promise<StartedPrivateRuntimeTurn<T>> {
    throw new RuntimeProviderError(
      "RUNTIME_UNAVAILABLE",
      "No local connector is attached to this runtime binding",
    );
  }

  async cancel(): Promise<boolean> {
    return false;
  }
}

/**
 * Fail-closed identity.
 *
 * Conversation actions need the acting user, but the control plane currently
 * authenticates one shared deployment token that identifies nobody. A
 * browser-supplied user ID would be forgeable, so requests are refused until a
 * real per-user authentication source is composed.
 */
export const unresolvedAuthenticatedUserId: AuthenticatedUserResolver = () => {
  throw new HttpError(401, "Per-user authentication is not configured");
};

export interface ConversationApiFactoryOptions {
  /**
   * Conversation persistence override. When omitted, the repository is chosen
   * by `CONVERSATION_PERSISTENCE`, which defaults to the in-memory adapter and
   * therefore does not survive a restart.
   */
  repository?: ConversationRepository | undefined;
  runtime?: PrivateDraftTurnRuntime | undefined;
  authenticatedUserId?: AuthenticatedUserResolver | undefined;
  authorizer?: PrivateRuntimeAuthorizer | undefined;
  /**
   * The capability loop (build plan 8). Omitted, a turn that asks for files
   * on a collaborator's machine simply answers without them: no question
   * crosses, and nothing is asserted on anyone's behalf.
   */
  followUp?: PrivateDraftFollowUp | undefined;
}

/**
 * Composition root for the canonical conversation API.
 *
 * Every optional seam has a fail-closed default. Production bootstrap supplies
 * per-user identity and the connector runtime only when their durable backing
 * services are configured.
 */
export function createConversationApi(
  config: Readonly<AppConfig>,
  options: Readonly<ConversationApiFactoryOptions> = {},
): ConversationRouteDependencies {
  const authorizer = options.authorizer ?? new PrivateRuntimeAuthorizationService(
    createConfiguredAuthorizationRepository(config),
    { repositoryAccessMaxAgeMs, repositoryReadTimeoutMs },
  );
  const service = new ConversationService(
    options.repository ?? createConfiguredConversationRepository(config),
    new AuthorizedConversationAccess(authorizer),
    options.runtime ?? new ConnectorUnavailableDraftRuntime(),
    options.followUp ? { followUp: options.followUp } : {},
  );
  return {
    service,
    authenticatedUserId:
      options.authenticatedUserId ?? unresolvedAuthenticatedUserId,
  };
}
