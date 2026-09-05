import type {
  ConnectorPrincipal,
  RepositoryProof,
  RepositoryProofResult,
  RepositoryUnavailable,
  RepositoryUnavailableResult,
} from "./contract.js";

export interface RegisterRepositoryProofCommand {
  principal: ConnectorPrincipal;
  proof: RepositoryProof;
  repositoryFullName: string;
  payloadDigestHex: string;
}

export interface MarkRepositoryUnavailableCommand {
  principal: ConnectorPrincipal;
  githubRepositoryId: string;
  event: RepositoryUnavailable;
}

export interface RepositoryProofRepository {
  /**
   * Verifies that the transport-authenticated user owns the GitHub identity
   * named by a connector proof. This cheap database gate must run before any
   * request is made against GitHub's deployment-wide anonymous quota.
   */
  authorizeProofIdentity(
    principal: Readonly<ConnectorPrincipal>,
    github: Readonly<RepositoryProof["github"]>,
  ): Promise<void>;

  registerRepositoryProof(
    command: Readonly<RegisterRepositoryProofCommand>,
  ): Promise<RepositoryProofResult>;

  markRepositoryUnavailable(
    command: Readonly<MarkRepositoryUnavailableCommand>,
  ): Promise<RepositoryUnavailableResult>;
}
