import { createHash } from "node:crypto";
import { isGitHubRepositoryId } from "../authorization/github-repository-id.js";
import {
  connectorPrincipalSchema,
  repositoryProofSchema,
  repositoryUnavailableSchema,
  type ConnectorPrincipal,
  type RepositoryProofResult,
  type RepositoryUnavailableResult,
} from "./contract.js";
import type { RepositoryProofRepository } from "./repository.js";
import { REPOSITORY_ACCESS_MAX_AGE_MS } from "./lifetime.js";

const maximumClockLeadMs = 5 * 60 * 1_000;

export type RepositoryProofErrorCode =
  | "REPOSITORY_PROOF_INVALID"
  | "REPOSITORY_PROOF_FORBIDDEN"
  | "REPOSITORY_PROOF_CONFLICT"
  | "REPOSITORY_PROOF_UNAVAILABLE";

export class RepositoryProofError extends Error {
  constructor(
    readonly code: RepositoryProofErrorCode,
    message: string,
    readonly statusCode: 400 | 403 | 409 | 503,
  ) {
    super(message);
    this.name = "RepositoryProofError";
  }
}

export class RepositoryProofService {
  constructor(
    private readonly repository: RepositoryProofRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async register(
    untrustedPrincipal: unknown,
    untrustedProof: unknown,
  ): Promise<RepositoryProofResult> {
    const principal = parsePrincipal(untrustedPrincipal);
    const proof = parseProof(untrustedProof);
    this.assertFresh(proof.observedAt);

    const repositoryFullName = `${proof.repository.owner}/${proof.repository.name}`;
    const payloadDigestHex = createHash("sha256")
      .update(
        JSON.stringify({
          principal,
          proof,
          repositoryFullName,
        }),
        "utf8",
      )
      .digest("hex");

    try {
      return await this.repository.registerRepositoryProof({
        principal,
        proof,
        repositoryFullName,
        payloadDigestHex,
      });
    } catch (error) {
      throw normalizeRepositoryError(error);
    }
  }

  async markUnavailable(
    untrustedPrincipal: unknown,
    untrustedRepositoryId: unknown,
    untrustedEvent: unknown,
  ): Promise<RepositoryUnavailableResult> {
    const principal = parsePrincipal(untrustedPrincipal);
    if (!isGitHubRepositoryId(untrustedRepositoryId)) {
      throw invalidProof();
    }
    const event = repositoryUnavailableSchema.safeParse(untrustedEvent);
    if (!event.success) throw invalidProof();
    this.assertFresh(event.data.observedAt);

    try {
      return await this.repository.markRepositoryUnavailable({
        principal,
        githubRepositoryId: untrustedRepositoryId,
        event: event.data,
      });
    } catch (error) {
      throw normalizeRepositoryError(error);
    }
  }

  private assertFresh(observedAt: string): void {
    const observed = Date.parse(observedAt);
    const current = this.now().getTime();
    if (
      !Number.isFinite(observed) ||
      observed < current - REPOSITORY_ACCESS_MAX_AGE_MS ||
      observed > current + maximumClockLeadMs
    ) {
      throw invalidProof();
    }
  }
}

function parsePrincipal(value: unknown): ConnectorPrincipal {
  const parsed = connectorPrincipalSchema.safeParse(value);
  if (!parsed.success) {
    throw new RepositoryProofError(
      "REPOSITORY_PROOF_FORBIDDEN",
      "Connector authentication required",
      403,
    );
  }
  return parsed.data;
}

function parseProof(value: unknown) {
  const parsed = repositoryProofSchema.safeParse(value);
  if (!parsed.success) throw invalidProof();
  return parsed.data;
}

function invalidProof(): RepositoryProofError {
  return new RepositoryProofError(
    "REPOSITORY_PROOF_INVALID",
    "Repository proof is invalid",
    400,
  );
}

function normalizeRepositoryError(error: unknown): RepositoryProofError {
  if (error instanceof RepositoryProofError) return error;
  return new RepositoryProofError(
    "REPOSITORY_PROOF_UNAVAILABLE",
    "Repository proof service is temporarily unavailable",
    503,
  );
}
