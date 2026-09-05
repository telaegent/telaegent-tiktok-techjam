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
   * named by a connector proof. The registration RPC repeats the same check
   * transactionally before it creates or restores repository authorization.
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
