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
  registerRepositoryProof(
    command: Readonly<RegisterRepositoryProofCommand>,
  ): Promise<RepositoryProofResult>;

  markRepositoryUnavailable(
    command: Readonly<MarkRepositoryUnavailableCommand>,
  ): Promise<RepositoryUnavailableResult>;
}

