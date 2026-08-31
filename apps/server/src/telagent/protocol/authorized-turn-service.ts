import {
  AuthorizedPrivateRuntimeTurnStarter,
  type AuthorizedPrivateRuntimeTurnPolicy,
  type AuthorizedPrivateRuntimeTurnInput,
} from "../../authorization/authorized-private-runtime-turn.js";
import type { PrivateRuntimeAuthorizer } from "../../authorization/private-runtime-authorization.js";
import {
  ConnectorTurnExecutor,
  type ConnectorJobRelay,
} from "../../connectors/connector-turn-executor.js";
import type { AuthorizePrivateRuntimeInput } from "../../authorization/types.js";
import {
  PrivateRuntimeTurnCoordinator,
  type PrivateRuntimeTurnCoordinatorOptions,
  type PrivateTurnExecutor,
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
  type DeliveredResourceBlock,
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
  /** Backend-owned identifier claimed in draft persistence before dispatch. */
  turnId?: string;
  format?: ProtocolFormatId;
  sessionMode?: SessionMode;
  /**
   * Files a peer's human approved during an earlier round of this same turn
   * (build plan 8.6).
   *
   * They ride in the prompt and are dropped when the turn ends. Durable
   * context is never asked to hold them, so the cloud does not become a store
   * of another person's source.
   */
  deliveredResources?: readonly DeliveredResourceBlock[] | undefined;
}

export interface AuthorizedProtocolTurnServiceOptions {
  onContextRejected?: ProtocolContextRejectionReporter;
}

/**
 * Canonical cloud composition. Every turn leaves as a path-free connector job,
 * so the cloud owns no provider process, workspace, or provider session.
 */
export interface ConnectorProtocolTurnExecution {
  connector: ConnectorJobRelay;
  createJobId?: () => string;
}

/**
 * Connector-side/local composition. The provider CLI runs in this process, so
 * it is only valid inside a local connector, a dev script, or a test.
 */
export interface LocalProtocolTurnExecution {
  runtime: ProviderSessionRuntime;
  sessionStore: ProviderSessionStore;
}

export type AuthorizedProtocolTurnRuntimeDependencies =
  AuthorizedProtocolTurnServiceOptions & {
    authorizer: PrivateRuntimeAuthorizer;
    loadContext: DurableContextLoader;
    policy: Readonly<AuthorizedPrivateRuntimeTurnPolicy>;
    coordinatorOptions?: PrivateRuntimeTurnCoordinatorOptions;
  } & (ConnectorProtocolTurnExecution | LocalProtocolTurnExecution);

export interface AuthorizedProtocolTurnRuntime {
  turns: AuthorizedProtocolTurnService;
  coordinator: PrivateRuntimeTurnCoordinator;
  /**
   * Present only for the local composition. Provider sessions are a private
   * connector-side cache and never exist in the cloud build.
   */
  sessions?: ProviderSessionManager | undefined;
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
  // Provider session recovery is a local concern: the connector rebuilds a lost
  // session from the bounded summary the cloud already puts in every job, so
  // the hydrator exists only where a provider actually runs in-process.
  let sessions: ProviderSessionManager | undefined;
  let executor: PrivateTurnExecutor;
  if ("connector" in dependencies) {
    executor = new ConnectorTurnExecutor(
      dependencies.connector,
      dependencies.createJobId ? { createJobId: dependencies.createJobId } : {},
    );
  } else {
    sessions = new ProviderSessionManager(
      dependencies.runtime,
      dependencies.sessionStore,
      createProtocolHydrator({
        load: dependencies.loadContext,
        ...(dependencies.onContextRejected
          ? { onHydrationRejected: dependencies.onContextRejected }
          : {}),
      }),
    );
    executor = sessions;
  }
  const coordinator = new PrivateRuntimeTurnCoordinator(
    executor,
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
      correlationId: input.correlationId,
      ...(this.options.onContextRejected
        ? { onRejected: this.options.onContextRejected }
        : {}),
    });
    const turn = buildPreparedPrivateTurn({
      context,
      correlationId: input.correlationId,
      ...(input.format ? { format: input.format } : {}),
      ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
      ...(input.deliveredResources?.length
        ? { deliveredResources: input.deliveredResources }
        : {}),
    });

    const starterInput: AuthorizedPrivateRuntimeTurnInput = {
      authorization: input.authorization,
      provider: input.provider,
      turn,
      ...(input.turnId ? { turnId: input.turnId } : {}),
    };
    return this.starter.start<T>(starterInput);
  }
}
