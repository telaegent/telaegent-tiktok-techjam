import type {
  PrivateRuntimeAuthorizationReadOptions,
  PrivateRuntimeAuthorizationRepository,
  PrivateRuntimeAuthorizationSnapshot,
} from "./repository.js";
import type {
  AuthorizePrivateRuntimeInput,
  GitHubConnection,
  GitHubRepositoryAccess,
  ProjectConnection,
  ProjectConversation,
  ProjectMembership,
  RepositoryProject,
  RuntimeBinding,
  UserAccount,
} from "./types.js";

const KEY_SEPARATOR = "\u0000";
const DEFAULT_MAXIMUM_PROJECT_CONNECTIONS = 100;

export interface InMemoryPrivateRuntimeAuthorizationData {
  readonly users: readonly UserAccount[];
  readonly githubConnections: readonly GitHubConnection[];
  readonly repositoryAccesses: readonly GitHubRepositoryAccess[];
  readonly projects: readonly RepositoryProject[];
  readonly memberships: readonly ProjectMembership[];
  readonly conversations: readonly ProjectConversation[];
  readonly projectConnections: readonly ProjectConnection[];
  readonly runtimeBindings: readonly RuntimeBinding[];
}

interface AuthorizationIndexes {
  readonly usersById: ReadonlyMap<string, UserAccount>;
  readonly githubConnectionsByUserId: ReadonlyMap<string, GitHubConnection>;
  readonly repositoryAccessesByUserAndRepository: ReadonlyMap<
    string,
    GitHubRepositoryAccess
  >;
  readonly projectsByRepositoryId: ReadonlyMap<string, RepositoryProject>;
  readonly membershipsByProjectAndUser: ReadonlyMap<string, ProjectMembership>;
  readonly conversationsById: ReadonlyMap<string, ProjectConversation>;
  readonly projectConnectionsByProjectAndPair: ReadonlyMap<string, ProjectConnection>;
  readonly runtimeBindingsByProjectAndUser: ReadonlyMap<string, RuntimeBinding>;
}

/**
 * An indexed authorization fact store for development, tests, and the period
 * before the Supabase adapter lands. It mirrors a single database snapshot:
 * replacement data is fully validated and indexed before it becomes visible.
 *
 * This adapter deliberately returns inactive and revoked facts. Permission
 * decisions remain centralized in PrivateRuntimeAuthorizationService.
 */
export class InMemoryPrivateRuntimeAuthorizationRepository
  implements PrivateRuntimeAuthorizationRepository
{
  private indexes: AuthorizationIndexes;

  constructor(data: InMemoryPrivateRuntimeAuthorizationData) {
    this.indexes = buildIndexes(data);
  }

  /**
   * Atomically replaces all authorization facts. If validation fails, the
   * previously active snapshot remains untouched.
   */
  replaceData(data: InMemoryPrivateRuntimeAuthorizationData): void {
    const nextIndexes = buildIndexes(data);
    this.indexes = nextIndexes;
  }

  async loadPrivateRuntimeAuthorizationSnapshot(
    input: Readonly<AuthorizePrivateRuntimeInput>,
    options?: Readonly<PrivateRuntimeAuthorizationReadOptions>,
  ): Promise<PrivateRuntimeAuthorizationSnapshot> {
    throwIfAborted(options?.signal);

    const maximumProjectConnections =
      options?.maximumProjectConnections ?? DEFAULT_MAXIMUM_PROJECT_CONNECTIONS;
    assertMaximumProjectConnections(maximumProjectConnections);

    // Capture one immutable index generation so replaceData cannot mix facts
    // from two logical snapshots during this read.
    const indexes = this.indexes;
    const user = indexes.usersById.get(input.authenticatedUserId) ?? null;
    const githubConnection =
      indexes.githubConnectionsByUserId.get(input.authenticatedUserId) ?? null;
    const repositoryAccess =
      indexes.repositoryAccessesByUserAndRepository.get(
        compoundKey(input.authenticatedUserId, input.githubRepositoryId),
      ) ?? null;
    const project = indexes.projectsByRepositoryId.get(input.githubRepositoryId) ?? null;
    const conversationRecord = indexes.conversationsById.get(input.conversationId) ?? null;

    const projectId = project?.projectId;
    const membership = projectId
      ? (indexes.membershipsByProjectAndUser.get(
          compoundKey(projectId, input.authenticatedUserId),
        ) ?? null)
      : null;
    const runtimeBinding = projectId
      ? (indexes.runtimeBindingsByProjectAndUser.get(
          compoundKey(projectId, input.authenticatedUserId),
        ) ?? null)
      : null;

    // Read only enough participants and relationships for the service to
    // detect configured cardinality overflow. This prevents attacker-created
    // records from causing an unbounded per-request allocation.
    const conversation = conversationRecord
      ? cloneConversationBounded(
          conversationRecord,
          maximumProjectConnections + 2,
        )
      : null;
    const projectConnections =
      projectId && conversation
        ? selectProjectConnections(
            indexes,
            projectId,
            input.authenticatedUserId,
            conversation.participantUserIds,
            maximumProjectConnections + 1,
          )
        : [];

    throwIfAborted(options?.signal);

    // Never expose references retained by the repository. Tests and future
    // adapters can safely transform returned values without mutating policy.
    return structuredClone({
      user,
      githubConnection,
      repositoryAccess,
      project,
      membership,
      conversation,
      projectConnections,
      runtimeBinding,
    });
  }
}

function buildIndexes(data: InMemoryPrivateRuntimeAuthorizationData): AuthorizationIndexes {
  const ownedData = structuredClone(data);
  const usersById = uniqueIndex(ownedData.users, (record) => keyPart(record.userId));
  const githubConnectionsByUserId = uniqueIndex(
    ownedData.githubConnections,
    (record) => keyPart(record.userId),
  );
  assertUnique(ownedData.githubConnections, (record) =>
    keyPart(record.githubConnectionId),
  );
  const repositoryAccessesByUserAndRepository = uniqueIndex(
    ownedData.repositoryAccesses,
    (record) => compoundKey(record.userId, record.githubRepositoryId),
  );
  const projectsByRepositoryId = uniqueIndex(
    ownedData.projects,
    (record) => keyPart(record.githubRepositoryId),
  );
  assertUnique(ownedData.projects, (record) => keyPart(record.projectId));
  const membershipsByProjectAndUser = uniqueIndex(
    ownedData.memberships,
    (record) => compoundKey(record.projectId, record.userId),
  );
  const conversationsById = uniqueIndex(
    ownedData.conversations,
    (record) => keyPart(record.conversationId),
  );
  const runtimeBindingsByProjectAndUser = uniqueIndex(
    ownedData.runtimeBindings,
    (record) => compoundKey(record.projectId, record.userId),
  );
  assertUnique(ownedData.runtimeBindings, (record) =>
    keyPart(record.runtimeBindingId),
  );

  const uniqueConnections = uniqueIndex(ownedData.projectConnections, (record) => {
    if (record.requesterUserId === record.recipientUserId) {
      throw malformedDataError();
    }
    const participants = [record.requesterUserId, record.recipientUserId].sort();
    return compoundKey(record.projectId, participants[0]!, participants[1]!);
  });
  assertUnique(ownedData.projectConnections, (record) =>
    keyPart(record.projectConnectionId),
  );
  return {
    usersById,
    githubConnectionsByUserId,
    repositoryAccessesByUserAndRepository,
    projectsByRepositoryId,
    membershipsByProjectAndUser,
    conversationsById,
    projectConnectionsByProjectAndPair: uniqueConnections,
    runtimeBindingsByProjectAndUser,
  };
}

function uniqueIndex<T>(
  records: readonly T[],
  getKey: (record: T) => string,
): ReadonlyMap<string, T> {
  const index = new Map<string, T>();
  for (const record of records) {
    const key = getKey(record);
    if (index.has(key)) {
      throw malformedDataError();
    }
    index.set(key, record);
  }
  return index;
}

function assertUnique<T>(
  records: readonly T[],
  getKey: (record: T) => string,
): void {
  uniqueIndex(records, getKey);
}

function selectProjectConnections(
  indexes: AuthorizationIndexes,
  projectId: string,
  authenticatedUserId: string,
  participantUserIds: readonly string[],
  limit: number,
): ProjectConnection[] {
  const selected: ProjectConnection[] = [];

  for (const peerUserId of participantUserIds) {
    if (peerUserId === authenticatedUserId) {
      continue;
    }
    const pair = [authenticatedUserId, peerUserId].sort();
    const connection = indexes.projectConnectionsByProjectAndPair.get(
      compoundKey(projectId, pair[0]!, pair[1]!),
    );
    if (!connection) continue;
    selected.push(connection);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

function cloneConversationBounded(
  conversation: ProjectConversation,
  participantLimit: number,
): ProjectConversation {
  return {
    ...conversation,
    participantUserIds: conversation.participantUserIds.slice(0, participantLimit),
  };
}

function compoundKey(...parts: readonly string[]): string {
  return parts.map(keyPart).join(KEY_SEPARATOR);
}

function keyPart(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes(KEY_SEPARATOR)) {
    throw malformedDataError();
  }
  return value;
}

function assertMaximumProjectConnections(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > DEFAULT_MAXIMUM_PROJECT_CONNECTIONS) {
    throw new Error("Invalid authorization repository read options.");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  const error = new Error("Authorization repository read aborted.");
  error.name = "AbortError";
  throw error;
}

function malformedDataError(): Error {
  return new Error("Invalid in-memory authorization data.");
}
