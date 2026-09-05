import { describe, expect, it, vi } from "vitest";
import type { RepositoryProofRepository } from "./repository.js";
import { RepositoryProofError, RepositoryProofService } from "./service.js";

const now = new Date("2026-08-31T02:00:00.000Z");
const principal = {
  authenticatedUserId: "10000000-0000-4000-8000-000000000001",
  connectorInstanceId: "connector_instance_0001",
};
const proof = {
  version: 1,
  proofId: "20000000-0000-4000-8000-000000000002",
  observedAt: "2026-08-31T01:59:30.000Z",
  github: { userId: "123456789", login: "khoa-dao" },
  repository: {
    id: "9223372036854775807",
    owner: "Telaegent",
    name: "codejam.repo",
    visibility: "private",
    defaultBranch: "main",
    currentBranch: "khoa.dao",
    commitSha: "a".repeat(40),
    permission: "write",
  },
} as const;
const registration = {
  proofId: proof.proofId,
  githubConnectionId: "30000000-0000-4000-8000-000000000003",
  projectId: "40000000-0000-4000-8000-000000000004",
  githubRepositoryId: proof.repository.id,
  connectorBindingId: "50000000-0000-4000-8000-000000000005",
  accessStatus: "verified",
  membershipStatus: "active",
  bindingStatus: "ready",
  verifiedAt: proof.observedAt,
  replayed: false,
} as const;

function fixture() {
  const repository = {
    authorizeProofIdentity: vi.fn(async () => undefined),
    registerRepositoryProof: vi.fn(async () => registration),
    markRepositoryUnavailable: vi.fn(async () => ({
      githubRepositoryId: proof.repository.id,
      accessStatus: "revalidation_required" as const,
      membershipStatus: "suspended" as const,
      bindingStatus: "unavailable" as const,
      changed: true,
    })),
  } satisfies RepositoryProofRepository;
  return {
    repository,
    service: new RepositoryProofService(repository, () => now),
  };
}

describe("RepositoryProofService", () => {
  it("normalizes a safe proof and derives deterministic binding input", async () => {
    const { repository, service } = fixture();

    await expect(service.register(principal, proof)).resolves.toEqual(registration);

    const command = repository.registerRepositoryProof.mock.calls[0]![0];
    expect(command).toMatchObject({
      principal,
      proof,
      repositoryFullName: "Telaegent/codejam.repo",
    });
    expect(command.payloadDigestHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(["private", "internal"] as const)(
    "accepts an authenticated local gh proof for a %s repository",
    async (visibility) => {
      const { repository, service } = fixture();
      const localProof = {
        ...proof,
        repository: {
          ...proof.repository,
          visibility,
          permission: "write" as const,
        },
      };

      await expect(service.register(principal, localProof)).resolves.toEqual(registration);
      expect(repository.authorizeProofIdentity).toHaveBeenCalledWith(
        principal,
        localProof.github,
      );
      expect(repository.registerRepositoryProof).toHaveBeenCalledWith(
        expect.objectContaining({ proof: localProof }),
      );
    },
  );

  it("rejects an unowned local GitHub identity before registration", async () => {
    const { repository, service } = fixture();
    repository.authorizeProofIdentity.mockRejectedValueOnce(
      new RepositoryProofError(
        "REPOSITORY_PROOF_FORBIDDEN",
        "Repository proof is not authorized",
        403,
      ),
    );

    await expect(service.register(principal, proof)).rejects.toMatchObject({
      code: "REPOSITORY_PROOF_FORBIDDEN",
      statusCode: 403,
    });
    expect(repository.registerRepositoryProof).not.toHaveBeenCalled();
  });

  it("rejects body-injected identity, local paths, remotes, tokens, and raw output", async () => {
    const forbiddenFields = [
      ["authenticatedUserId", principal.authenticatedUserId],
      ["workspacePath", "D:/private/repo"],
      ["remoteUrl", "https://token@github.com/org/repo.git"],
      ["token", "ghp_secret"],
      ["rawOutput", "credential-bearing output"],
    ] as const;
    for (const [key, value] of forbiddenFields) {
      const { repository, service } = fixture();
      await expect(
        service.register(principal, { ...proof, [key]: value }),
      ).rejects.toMatchObject({
        code: "REPOSITORY_PROOF_INVALID",
        statusCode: 400,
      });
      expect(repository.registerRepositoryProof).not.toHaveBeenCalled();
    }
  });

  it("rejects stale/future observations and malformed repository facts", async () => {
    for (const candidate of [
      { ...proof, observedAt: "2026-08-31T01:44:59.999Z" },
      { ...proof, observedAt: "2026-08-31T02:05:00.001Z" },
      { ...proof, repository: { ...proof.repository, id: "9223372036854775808" } },
      { ...proof, repository: { ...proof.repository, currentBranch: "../secret" } },
      { ...proof, repository: { ...proof.repository, commitSha: "A".repeat(40) } },
    ]) {
      const { repository, service } = fixture();
      await expect(service.register(principal, candidate)).rejects.toMatchObject({
        code: "REPOSITORY_PROOF_INVALID",
      });
      expect(repository.registerRepositoryProof).not.toHaveBeenCalled();
    }
  });

  it("requires a transport-authenticated connector principal", async () => {
    const { repository, service } = fixture();
    await expect(service.register({}, proof)).rejects.toMatchObject({
      code: "REPOSITORY_PROOF_FORBIDDEN",
      statusCode: 403,
    });
    expect(repository.registerRepositoryProof).not.toHaveBeenCalled();
  });

  it("suspends only the exact repository binding owned by the connector", async () => {
    const { repository, service } = fixture();
    await service.markUnavailable(principal, proof.repository.id, {
      observedAt: proof.observedAt,
      reason: "repository_access_lost",
    });
    expect(repository.markRepositoryUnavailable).toHaveBeenCalledWith({
      principal,
      githubRepositoryId: proof.repository.id,
      event: {
        observedAt: proof.observedAt,
        reason: "repository_access_lost",
      },
    });
  });

  it("never exposes persistence details", async () => {
    const { repository, service } = fixture();
    repository.registerRepositoryProof.mockRejectedValueOnce(
      new Error("SQL included local path D:/private and sb_secret_value"),
    );
    await expect(service.register(principal, proof)).rejects.toEqual(
      expect.objectContaining({
        code: "REPOSITORY_PROOF_UNAVAILABLE",
        message: "Repository proof service is temporarily unavailable",
      }),
    );
  });
});
