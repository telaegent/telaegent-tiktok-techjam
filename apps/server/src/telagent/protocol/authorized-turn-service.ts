import {
  AuthorizedPrivateRuntimeTurnStarter,
  type AuthorizedPrivateRuntimeTurnPolicy,
  type AuthorizedPrivateRuntimeTurnInput,
} from "../../authorization/authorized-private-runtime-turn.js";
import type { PrivateRuntimeAuthorizer } from "../../authorization/private-runtime-authorization.js";
import type { AuthorizePrivateRuntimeInput } from "../../authorization/types.js";
import {
  PrivateRuntimeTurnCoordinator,
  type PrivateRuntimeTurnCoordinatorOptions,
  type StartedPrivateRuntimeTurn,
} from "../../private-runtime-turn-coordinator.js";
import {
  ProviderSessionManager,
  type ProviderSessionRuntime,
  type ProviderSessionScope,
  type ProviderSessionStore,
} from "../../provider-session-manager.js";
import type { AgentProvider, SessionMode } from "../../runtime-contract.js";
import type { ProtocolFormatId, ProtocolRole } from "./contract.js";
import {
  PROTOCOL_PURPOSES,
  buildPreparedPrivateTurn,
  createProtocolHydrator,
  loadValidatedDurableContext,
  type DurableContextLoader,
  type ProtocolContextRejectionReporter,
} from "./runtime-adapter.js";

/**
 * Trusted backend input for one private protocol turn.
 *
 * HTTP adapters must derive `authenticatedUserId` from the authenticated server
 * session. They may select provider, role, format, and session behavior, but can
 * never provide context, workspace paths, runtime bindings, or execution policy.
 */
export interface StartAuthorizedProtocolTurnInput {
  authorization: Readonly<AuthorizePrivateRuntimeInput>;
  provider: AgentProvider;
  role: ProtocolRole;
  correlationId: string;
  format?: ProtocolFormatId;
  sessionMode?: SessionMode;
}

export interface AuthorizedProtocolTurnServiceOptions {
  onContextRejected?: ProtocolContextRejectionReporter;
}

export interface AuthorizedProtocolTurnRuntimeDependencies
  extends AuthorizedProtocolTurnServiceOptions {
  authorizer: PrivateRuntimeAuthorizer;
  loadContext: DurableContextLoader;
  runtime: ProviderSessionRuntime;
  sessionStore: ProviderSessionStore;
  policy: Readonly<AuthorizedPrivateRuntimeTurnPolicy>;
  coordinatorOptions?: PrivateRuntimeTurnCoordinatorOptions;
}

export interface AuthorizedProtocolTurnRuntime {
  turns: AuthorizedProtocolTurnService;
  coordinator: PrivateRuntimeTurnCoordinator;
  sessions: ProviderSessionManager;
}

/**
 * Safe composition root for a server bootstrap or dependency-injection module.
 * One durable loader is deliberately shared by initial preparation and session
 * recovery, preventing different adapters or scope rules from being wired on
 * the two paths.
 */
export function createAuthorizedProtocolTurnRuntime(
  dependencies: AuthorizedProtocolTurnRuntimeDependencies,
): AuthorizedProtocolTurnRuntime {
  const hydrator = createProtocolHydrator({
    load: dependencies.loadContext,
    ...(dependencies.onContextRejected
      ? { onHydrationRejected: dependencies.onContextRejected }
      : {}),
  });
  const sessions = new ProviderSessionManager(
    dependencies.runtime,
    dependencies.sessionStore,
    hydrator,
  );
  const coordinator = new PrivateRuntimeTurnCoordinator(
    sessions,
    undefined,
    dependencies.coordinatorOptions,
  );
  const starter = new AuthorizedPrivateRuntimeTurnStarter(
    dependencies.authorizer,
    coordinator,
    dependencies.policy,
  );
  const turns = new AuthorizedProtocolTurnService(
    dependencies.authorizer,
    dependencies.loadContext,
    starter,
    dependencies.onContextRejected
      ? { onContextRejected: dependencies.onContextRejected }
      : {},
  );
  return { turns, coordinator, sessions };
}

/**
 * The production composition root for Hien's protocol, Khoa's authorization,
 * and Phuong's runtime/session layers.
 *
 * It intentionally authorizes twice: once before reading private durable
 * context, and again inside the starter immediately before runtime selection.
 * The starter also re-authorizes after queueing. This prevents unauthorized
 * context reads and closes revocation races without putting infrastructure
 * fields into the protocol contract.
 */
export class AuthorizedProtocolTurnService {
  constructor(
    private readonly authorizer: PrivateRuntimeAuthorizer,
    private readonly loadContext: DurableContextLoader,
    private readonly starter: AuthorizedPrivateRuntimeTurnStarter,
    private readonly options: AuthorizedProtocolTurnServiceOptions = {},
  ) {}

  async start<T = unknown>(
    input: Readonly<StartAuthorizedProtocolTurnInput>,
  ): Promise<StartedPrivateRuntimeTurn<T>> {
    const authorized = await this.authorizer.authorizePrivateRuntime(
      input.authorization,
    );
    const scope: ProviderSessionScope = {
      userId: authorized.userId,
      githubRepositoryId: authorized.githubRepositoryId,
      conversationId: input.authorization.conversationId,
      provider: input.provider,
    };
    const purpose = PROTOCOL_PURPOSES[input.role];
    const context = await loadValidatedDurableContext({
      load: this.loadContext,
      scope,
      purpose,
      ...(this.options.onContextRejected
        ? { onRejected: this.options.onContextRejected }
        : {}),
    });
    const turn = buildPreparedPrivateTurn({
      context,
      correlationId: input.correlationId,
      ...(input.format ? { format: input.format } : {}),
      ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
    });

    const starterInput: AuthorizedPrivateRuntimeTurnInput = {
      authorization: input.authorization,
      provider: input.provider,
      turn,
    };
    return this.starter.start<T>(starterInput);
  }
}
