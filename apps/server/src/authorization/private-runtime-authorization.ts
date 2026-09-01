import type {
  PrivateRuntimeAuthorizationRepository,
  PrivateRuntimeAuthorizationSnapshot,
} from "./repository.js";
import type {
  AuthorizedPrivateRuntime,
  AuthorizePrivateRuntimeInput,
  ProjectConnection,
  UserId,
} from "./types.js";
import { isGitHubRepositoryId } from "./github-repository-id.js";
import {
  REPOSITORY_ACCESS_MAXIMUM_CLOCK_SKEW_MS,
  repositoryAccessProofIsFresh,
} from "../repository-proof/lifetime.js";

export type PrivateRuntimeAuthorizationErrorCode =
  | "PRIVATE_RUNTIME_FORBIDDEN"
  | "PRIVATE_RUNTIME_AUTHORIZATION_UNAVAILABLE";

export type PrivateRuntimeAuthorizationDenialReason =
  | "invalid_request"
  | "inactive_user"
  | "github_connection_unavailable"
  | "repository_access_unavailable"
  | "repository_access_stale"
  | "project_unavailable"
  | "membership_unavailable"
  | "conversation_unavailable"
  | "project_connection_unavailable"
  | "runtime_binding_unavailable"
  | "inconsistent_scope"
  | "repository_read_failed";

/** Safe error: messages and reason codes contain no IDs, paths, or secrets. */
export class PrivateRuntimeAuthorizationError extends Error {
  public readonly reason: PrivateRuntimeAuthorizationDenialReason;

  constructor(
    public readonly code: PrivateRuntimeAuthorizationErrorCode,
    reason: PrivateRuntimeAuthorizationDenialReason,
  ) {
    super(
      code === "PRIVATE_RUNTIME_FORBIDDEN"
        ? "Private runtime is not authorized"
        : "Private runtime authorization is temporarily unavailable",
    );
    this.name = "PrivateRuntimeAuthorizationError";
    this.reason = reason;
    // Internal diagnostics must not be serialized into an HTTP JSON body.
    Object.defineProperty(this, "reason", {
      enumerable: false,
      writable: false,
      configurable: false,
      value: reason,
    });
  }
}

export interface PrivateRuntimeAuthorizationPolicy {
  /** Maximum age of the last successful user/repository access proof. */
  repositoryAccessMaxAgeMs: number;
  /** Database/snapshot read deadline. */
  repositoryReadTimeoutMs: number;
  /** Small future-timestamp tolerance for clock skew. */
  maximumClockSkewMs?: number | undefined;
  /** Bounds connection processing and malformed/hostile snapshots. */
  maximumConversationParticipants?: number | undefined;
}

export interface PrivateRuntimeAuthorizer {
  authorizePrivateRuntime(
    input: Readonly<AuthorizePrivateRuntimeInput>,
  ): Promise<AuthorizedPrivateRuntime>;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const defaultMaximumConversationParticipants = 16;

/**
 * Fail-closed product authorization for one private user x repository turn.
 *
 * No result from this service should be cached across turns: repository
 * access, membership, project connections, and runtime bindings are revocable.
 */
export class PrivateRuntimeAuthorizationService
  implements PrivateRuntimeAuthorizer
{
  private readonly maximumClockSkewMs: number;
  private readonly maximumConversationParticipants: number;

  constructor(
    private readonly repository: PrivateRuntimeAuthorizationRepository,
    private readonly policy: Readonly<PrivateRuntimeAuthorizationPolicy>,
    private readonly now: () => Date = () => new Date(),
  ) {
    validateDuration(policy.repositoryAccessMaxAgeMs, 1_000, 86_400_000);
    validateDuration(policy.repositoryReadTimeoutMs, 100, 30_000);
    this.maximumClockSkewMs =
      policy.maximumClockSkewMs ??
      REPOSITORY_ACCESS_MAXIMUM_CLOCK_SKEW_MS;
    validateDuration(this.maximumClockSkewMs, 0, 300_000);
    this.maximumConversationParticipants =
      policy.maximumConversationParticipants ??
      defaultMaximumConversationParticipants;
    if (
      !Number.isInteger(this.maximumConversationParticipants) ||
      this.maximumConversationParticipants < 2 ||
      this.maximumConversationParticipants > 100
    ) {
      throw new Error("Maximum conversation participants is invalid");
    }
  }

  async authorizePrivateRuntime(
    input: Readonly<AuthorizePrivateRuntimeInput>,
  ): Promise<AuthorizedPrivateRuntime> {
    this.validateInput(input);
    const snapshot = await this.loadSnapshot(input);
    this.validateSnapshot(input, snapshot);

    const binding = snapshot.runtimeBinding;
    if (!binding || binding.status !== "ready") {
      throw forbidden("runtime_binding_unavailable");
    }
    return {
      userId: input.authenticatedUserId,
      githubRepositoryId: input.githubRepositoryId,
      runtimeBindingId: binding.runtimeBindingId,
    };
  }

  private async loadSnapshot(
    input: Readonly<AuthorizePrivateRuntimeInput>,
  ): Promise<PrivateRuntimeAuthorizationSnapshot> {
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(unavailable("repository_read_failed"));
      }, this.policy.repositoryReadTimeoutMs);
      timeout.unref();
    });

    try {
      return await Promise.race([
        this.repository.loadPrivateRuntimeAuthorizationSnapshot(input, {
          signal: controller.signal,
          maximumProjectConnections:
            this.maximumConversationParticipants - 1,
        }),
        deadline,
      ]);
    } catch (error) {
      if (error instanceof PrivateRuntimeAuthorizationError) throw error;
      throw unavailable("repository_read_failed");
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private validateInput(input: Readonly<AuthorizePrivateRuntimeInput>): void {
    if (
      !identifierPattern.test(input.authenticatedUserId) ||
      !identifierPattern.test(input.conversationId) ||
      !isGitHubRepositoryId(input.githubRepositoryId)
    ) {
      throw forbidden("invalid_request");
    }
  }

  private validateSnapshot(
    input: Readonly<AuthorizePrivateRuntimeInput>,
    snapshot: Readonly<PrivateRuntimeAuthorizationSnapshot>,
  ): void {
    const user = snapshot.user;
    if (!user || user.status !== "active") throw forbidden("inactive_user");
    if (user.userId !== input.authenticatedUserId) {
      throw forbidden("inconsistent_scope");
    }

    const githubConnection = snapshot.githubConnection;
    if (!githubConnection || githubConnection.status !== "connected") {
      throw forbidden("github_connection_unavailable");
    }
    if (
      githubConnection.userId !== input.authenticatedUserId ||
      !isValidTimestamp(githubConnection.lastVerifiedAt)
    ) {
      throw forbidden("inconsistent_scope");
    }

    const repositoryAccess = snapshot.repositoryAccess;
    if (!repositoryAccess || repositoryAccess.status !== "verified") {
      throw forbidden("repository_access_unavailable");
    }
    if (
      repositoryAccess.userId !== input.authenticatedUserId ||
      repositoryAccess.githubConnectionId !==
        githubConnection.githubConnectionId ||
      repositoryAccess.githubRepositoryId !== input.githubRepositoryId
    ) {
      throw forbidden("inconsistent_scope");
    }
    this.requireFreshRepositoryAccess(repositoryAccess.verifiedAt);

    const project = snapshot.project;
    if (!project || project.status !== "active") {
      throw forbidden("project_unavailable");
    }
    if (project.githubRepositoryId !== input.githubRepositoryId) {
      throw forbidden("inconsistent_scope");
    }

    const membership = snapshot.membership;
    if (!membership || membership.status !== "active") {
      throw forbidden("membership_unavailable");
    }
    if (
      membership.userId !== input.authenticatedUserId ||
      membership.projectId !== project.projectId
    ) {
      throw forbidden("inconsistent_scope");
    }

    const conversation = snapshot.conversation;
    if (!conversation || conversation.status !== "active") {
      throw forbidden("conversation_unavailable");
    }
    if (
      conversation.conversationId !== input.conversationId ||
      conversation.projectId !== project.projectId
    ) {
      throw forbidden("inconsistent_scope");
    }
    const participants = this.validateParticipants(
      conversation.participantUserIds,
      input.authenticatedUserId,
    );
    this.validateProjectConnections(
      snapshot.projectConnections,
      project.projectId,
      input.authenticatedUserId,
      participants,
    );

    const binding = snapshot.runtimeBinding;
    if (!binding || binding.status !== "ready") return;
    if (
      binding.userId !== input.authenticatedUserId ||
      binding.projectId !== project.projectId ||
      binding.githubRepositoryId !== input.githubRepositoryId ||
      !identifierPattern.test(binding.runtimeBindingId)
    ) {
      throw forbidden("inconsistent_scope");
    }
  }

  private validateParticipants(
    participantUserIds: readonly UserId[],
    authenticatedUserId: UserId,
  ): ReadonlySet<UserId> {
    if (
      !Array.isArray(participantUserIds) ||
      participantUserIds.length < 2 ||
      participantUserIds.length > this.maximumConversationParticipants
    ) {
      throw forbidden("conversation_unavailable");
    }
    const participants = new Set(participantUserIds);
    if (
      participants.size !== participantUserIds.length ||
      !participants.has(authenticatedUserId) ||
      [...participants].some((participant) => !identifierPattern.test(participant))
    ) {
      throw forbidden("inconsistent_scope");
    }
    return participants;
  }

  private validateProjectConnections(
    connections: readonly ProjectConnection[],
    projectId: string,
    authenticatedUserId: UserId,
    participants: ReadonlySet<UserId>,
  ): void {
    if (!Array.isArray(connections) || connections.length > participants.size - 1) {
      throw forbidden("inconsistent_scope");
    }
    const connectedPeers = new Set<UserId>();
    for (const connection of connections) {
      if (connection.status !== "connected" || connection.projectId !== projectId) {
        throw forbidden("project_connection_unavailable");
      }
      const peer = connectionPeer(connection, authenticatedUserId);
      if (
        !peer ||
        !participants.has(peer) ||
        peer === authenticatedUserId ||
        connectedPeers.has(peer)
      ) {
        throw forbidden("inconsistent_scope");
      }
      connectedPeers.add(peer);
    }
    if (connectedPeers.size !== participants.size - 1) {
      throw forbidden("project_connection_unavailable");
    }
  }

  private requireFreshRepositoryAccess(verifiedAt: string): void {
    const nowMs = this.now().getTime();
    if (!repositoryAccessProofIsFresh(
      verifiedAt,
      nowMs,
      this.policy.repositoryAccessMaxAgeMs,
      this.maximumClockSkewMs,
    )) {
      throw forbidden("repository_access_stale");
    }
  }
}

function connectionPeer(
  connection: Readonly<ProjectConnection>,
  authenticatedUserId: UserId,
): UserId | null {
  if (connection.requesterUserId === authenticatedUserId) {
    return connection.recipientUserId;
  }
  if (connection.recipientUserId === authenticatedUserId) {
    return connection.requesterUserId;
  }
  return null;
}

function isValidTimestamp(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}

function validateDuration(value: number, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error("Private runtime authorization duration is invalid");
  }
}

function forbidden(
  reason: PrivateRuntimeAuthorizationDenialReason,
): PrivateRuntimeAuthorizationError {
  return new PrivateRuntimeAuthorizationError(
    "PRIVATE_RUNTIME_FORBIDDEN",
    reason,
  );
}

function unavailable(
  reason: PrivateRuntimeAuthorizationDenialReason,
): PrivateRuntimeAuthorizationError {
  return new PrivateRuntimeAuthorizationError(
    "PRIVATE_RUNTIME_AUTHORIZATION_UNAVAILABLE",
    reason,
  );
}
