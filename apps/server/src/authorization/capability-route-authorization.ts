import { isGitHubRepositoryId } from "./github-repository-id.js";
import type { CapabilityRouteAuthorizationRepository } from "./capability-repository.js";
import type {
  AuthorizedCapabilityRoute,
  AuthorizeCapabilityRouteInput,
  CapabilityRouteAuthorizationSnapshot,
} from "./capability-types.js";
import type { ProjectConnection, UserId } from "./types.js";

export type CapabilityRouteAuthorizationDenialReason =
  | "invalid_request"
  | "task_unavailable"
  | "task_expired"
  | "project_unavailable"
  | "conversation_unavailable"
  | "membership_unavailable"
  | "project_connection_unavailable"
  | "grant_unavailable"
  | "grant_expired"
  | "runtime_binding_unavailable"
  | "inconsistent_scope"
  | "repository_read_failed";

export class CapabilityRouteAuthorizationError extends Error {
  public readonly code:
    | "CAPABILITY_ROUTE_FORBIDDEN"
    | "CAPABILITY_ROUTE_AUTHORIZATION_UNAVAILABLE";

  constructor(
    code: CapabilityRouteAuthorizationError["code"],
    public readonly reason: CapabilityRouteAuthorizationDenialReason,
  ) {
    super(
      code === "CAPABILITY_ROUTE_FORBIDDEN"
        ? "Capability request is not authorized"
        : "Capability authorization is temporarily unavailable",
    );
    this.name = "CapabilityRouteAuthorizationError";
    this.code = code;
    Object.defineProperty(this, "reason", { enumerable: false });
  }
}

export interface CapabilityRouteAuthorizationPolicy {
  repositoryReadTimeoutMs: number;
  maximumClockSkewMs?: number | undefined;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const resourceId = /^resource_[A-Za-z0-9_-]{16,120}$/;

/**
 * Authorizes only cloud routing under an existing exact grant.
 *
 * It does not authorize a file read. The returned envelope must still reach
 * the owner's connector, which validates its local task/resource mapping,
 * current grant state, realpath containment, secret denials and byte limits
 * immediately before its file broker opens anything.
 */
export class CapabilityRouteAuthorizationService {
  private readonly maximumClockSkewMs: number;

  constructor(
    private readonly repository: CapabilityRouteAuthorizationRepository,
    private readonly policy: Readonly<CapabilityRouteAuthorizationPolicy>,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (
      !Number.isInteger(policy.repositoryReadTimeoutMs) ||
      policy.repositoryReadTimeoutMs < 100 ||
      policy.repositoryReadTimeoutMs > 30_000
    ) {
      throw new Error("Capability authorization read timeout is invalid");
    }
    this.maximumClockSkewMs = policy.maximumClockSkewMs ?? 60_000;
    if (
      !Number.isInteger(this.maximumClockSkewMs) ||
      this.maximumClockSkewMs < 0 ||
      this.maximumClockSkewMs > 300_000
    ) {
      throw new Error("Capability authorization clock skew is invalid");
    }
  }

  async authorizeRoute(
    input: Readonly<AuthorizeCapabilityRouteInput>,
  ): Promise<AuthorizedCapabilityRoute> {
    this.validateInput(input);
    const snapshot = await this.loadSnapshot(input);
    this.validateSnapshot(input, snapshot);
    const grant = snapshot.grant!;
    const binding = snapshot.ownerRuntimeBinding!;
    return {
      taskId: input.taskId,
      grantId: input.grantId,
      resourceId: input.resourceId,
      operation: "read",
      ownerUserId: input.ownerUserId,
      peerUserId: input.authenticatedUserId,
      githubRepositoryId: input.githubRepositoryId,
      conversationId: input.conversationId,
      ownerRuntimeBindingId: binding.runtimeBindingId,
      grantMode: grant.mode,
      grantExpiresAt: grant.expiresAt,
      requiresLocalAuthorization: true,
    };
  }

  private validateInput(input: Readonly<AuthorizeCapabilityRouteInput>): void {
    if (
      !identifier.test(input.authenticatedUserId) ||
      !identifier.test(input.ownerUserId) ||
      input.authenticatedUserId === input.ownerUserId ||
      !identifier.test(input.conversationId) ||
      !identifier.test(input.taskId) ||
      !identifier.test(input.grantId) ||
      !resourceId.test(input.resourceId) ||
      !isGitHubRepositoryId(input.githubRepositoryId) ||
      input.operation !== "read"
    ) {
      throw forbidden("invalid_request");
    }
  }

  private async loadSnapshot(
    input: Readonly<AuthorizeCapabilityRouteInput>,
  ): Promise<CapabilityRouteAuthorizationSnapshot> {
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
        this.repository.loadCapabilityRouteAuthorizationSnapshot(input, {
          signal: controller.signal,
        }),
        deadline,
      ]);
    } catch (error) {
      if (error instanceof CapabilityRouteAuthorizationError) throw error;
      throw unavailable("repository_read_failed");
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private validateSnapshot(
    input: Readonly<AuthorizeCapabilityRouteInput>,
    snapshot: Readonly<CapabilityRouteAuthorizationSnapshot>,
  ): void {
    const now = this.now().getTime();
    const task = snapshot.task;
    if (!task || task.status !== "active") throw forbidden("task_unavailable");
    if (
      task.taskId !== input.taskId ||
      task.githubRepositoryId !== input.githubRepositoryId ||
      task.conversationId !== input.conversationId ||
      !samePair(
        task.requesterUserId,
        task.responderUserId,
        input.authenticatedUserId,
        input.ownerUserId,
      ) ||
      task.endedAt !== null
    ) {
      throw forbidden("inconsistent_scope");
    }
    if (!activeAt(task.createdAt, task.expiresAt, now, this.maximumClockSkewMs)) {
      throw forbidden("task_expired");
    }

    const project = snapshot.project;
    if (!project || project.status !== "active") throw forbidden("project_unavailable");
    if (
      project.projectId !== task.projectId ||
      project.githubRepositoryId !== input.githubRepositoryId
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
    const participants = new Set(conversation.participantUserIds);
    if (
      participants.size !== conversation.participantUserIds.length ||
      participants.size !== 2 ||
      !participants.has(input.authenticatedUserId) ||
      !participants.has(input.ownerUserId)
    ) {
      throw forbidden("conversation_unavailable");
    }
    for (const [membership, userId] of [
      [snapshot.requesterMembership, input.authenticatedUserId],
      [snapshot.ownerMembership, input.ownerUserId],
    ] as const) {
      if (!membership || membership.status !== "active") {
        throw forbidden("membership_unavailable");
      }
      if (membership.projectId !== project.projectId || membership.userId !== userId) {
        throw forbidden("inconsistent_scope");
      }
    }

    const connection = snapshot.projectConnection;
    if (!connection || connection.status !== "connected") {
      throw forbidden("project_connection_unavailable");
    }
    if (
      connection.projectId !== project.projectId ||
      !connectionMatches(connection, input.authenticatedUserId, input.ownerUserId)
    ) {
      throw forbidden("inconsistent_scope");
    }

    const grant = snapshot.grant;
    if (!grant || grant.status !== "active") throw forbidden("grant_unavailable");
    if (
      grant.grantId !== input.grantId ||
      grant.taskId !== input.taskId ||
      grant.ownerUserId !== input.ownerUserId ||
      grant.peerUserId !== input.authenticatedUserId ||
      grant.grantedByUserId !== input.ownerUserId ||
      grant.resourceId !== input.resourceId ||
      grant.operation !== "read" ||
      grant.consumedAt !== null ||
      grant.revokedAt !== null ||
      Date.parse(grant.expiresAt) > Date.parse(task.expiresAt)
    ) {
      throw forbidden("inconsistent_scope");
    }
    if (!activeAt(grant.grantedAt, grant.expiresAt, now, this.maximumClockSkewMs)) {
      throw forbidden("grant_expired");
    }

    const binding = snapshot.ownerRuntimeBinding;
    if (!binding || binding.status !== "ready") {
      throw forbidden("runtime_binding_unavailable");
    }
    if (
      binding.userId !== input.ownerUserId ||
      binding.projectId !== project.projectId ||
      binding.githubRepositoryId !== input.githubRepositoryId
    ) {
      throw forbidden("inconsistent_scope");
    }
  }
}

function activeAt(
  startsAt: string,
  expiresAt: string,
  now: number,
  skew: number,
): boolean {
  const start = Date.parse(startsAt);
  const expiry = Date.parse(expiresAt);
  return (
    Number.isFinite(start) &&
    Number.isFinite(expiry) &&
    start <= now + skew &&
    expiry > now &&
    expiry > start
  );
}

function samePair(a: UserId, b: UserId, left: UserId, right: UserId): boolean {
  return (a === left && b === right) || (a === right && b === left);
}

function connectionMatches(
  connection: Readonly<ProjectConnection>,
  left: UserId,
  right: UserId,
): boolean {
  return samePair(connection.requesterUserId, connection.recipientUserId, left, right);
}

function forbidden(
  reason: CapabilityRouteAuthorizationDenialReason,
): CapabilityRouteAuthorizationError {
  return new CapabilityRouteAuthorizationError("CAPABILITY_ROUTE_FORBIDDEN", reason);
}

function unavailable(
  reason: CapabilityRouteAuthorizationDenialReason,
): CapabilityRouteAuthorizationError {
  return new CapabilityRouteAuthorizationError(
    "CAPABILITY_ROUTE_AUTHORIZATION_UNAVAILABLE",
    reason,
  );
}
