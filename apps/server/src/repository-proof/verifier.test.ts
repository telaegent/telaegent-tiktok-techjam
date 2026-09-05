import { describe, expect, it, vi } from "vitest";
import type { RepositoryProof } from "./contract.js";
import {
  GitHubPublicRepositoryProofVerifier,
  RepositoryProofVerificationError,
} from "./verifier.js";

const proof: RepositoryProof = {
  version: 1,
  proofId: "20000000-0000-4000-8000-000000000002",
  observedAt: "2026-09-05T01:00:00.000Z",
  github: { userId: "123456789", login: "khoa-dao" },
  repository: {
    id: "1345851084",
    owner: "telaegent",
    name: "telaegent-tiktok-techjam",
    visibility: "public",
    defaultBranch: "main",
    currentBranch: "khoa.dao",
    commitSha: "a".repeat(40),
    permission: "admin",
  },
};

function githubFetch(overrides: { repositoryStatus?: number } = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("/user/")) {
      return new Response('{"login":"khoa-dao","id":123456789}', {
        status: 200,
      });
    }
    return new Response(
      '{"name":"telaegent-tiktok-techjam","owner":{"login":"telaegent"},' +
        '"private":false,"visibility":"public","default_branch":"main",' +
        '"id":1345851084}',
      { status: overrides.repositoryStatus ?? 200 },
    );
  });
}

describe("GitHubPublicRepositoryProofVerifier", () => {
  it("independently verifies public identity and repository facts", async () => {
    const fetchImplementation = githubFetch();
    const verifier = new GitHubPublicRepositoryProofVerifier(
      5_000,
      fetchImplementation,
    );

    await expect(verifier.verify(proof)).resolves.toEqual({
      github: proof.github,
      repository: {
        id: proof.repository.id,
        owner: proof.repository.owner,
        name: proof.repository.name,
        visibility: "public",
        defaultBranch: "main",
        // The public API proves read access, not the connector's admin claim.
        permission: "read",
      },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(fetchImplementation.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.github.com/repositories/1345851084",
    ]);
    for (const [, init] of fetchImplementation.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(init).toMatchObject({
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
    }
  });

  it("coalesces and briefly caches a team's identical GitHub lookups", async () => {
    const fetchImplementation = githubFetch();
    const verifier = new GitHubPublicRepositoryProofVerifier(
      5_000,
      fetchImplementation,
    );

    await Promise.all([verifier.verify(proof), verifier.verify(proof)]);
    await verifier.verify(proof);

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("fails closed for private and internal connector assertions", async () => {
    const fetchImplementation = githubFetch();
    const verifier = new GitHubPublicRepositoryProofVerifier(
      5_000,
      fetchImplementation,
    );

    for (const visibility of ["private", "internal"] as const) {
      await expect(
        verifier.verify({
          ...proof,
          repository: { ...proof.repository, visibility },
        }),
      ).rejects.toEqual(new RepositoryProofVerificationError("UNVERIFIED"));
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("rejects fabricated repository IDs and GitHub 404s", async () => {
    const verifier = new GitHubPublicRepositoryProofVerifier(5_000, githubFetch());
    await expect(
      verifier.verify({
        ...proof,
        repository: { ...proof.repository, id: "999999999" },
      }),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });

    const missing = new GitHubPublicRepositoryProofVerifier(
      5_000,
      githubFetch({ repositoryStatus: 404 }),
    );
    await expect(missing.verify(proof)).rejects.toMatchObject({
      code: "UNVERIFIED",
    });
  });

  it("caches repeated denials and preserves part of the anonymous hourly quota", async () => {
    const missingFetch = githubFetch({ repositoryStatus: 404 });
    const missing = new GitHubPublicRepositoryProofVerifier(5_000, missingFetch);
    await expect(missing.verify(proof)).rejects.toMatchObject({ code: "UNVERIFIED" });
    await expect(missing.verify(proof)).rejects.toMatchObject({ code: "UNVERIFIED" });
    expect(missingFetch).toHaveBeenCalledTimes(1);

    const variedFetch = githubFetch();
    const bounded = new GitHubPublicRepositoryProofVerifier(5_000, variedFetch);
    for (let index = 0; index < 41; index += 1) {
      await expect(
        bounded.verify({
          ...proof,
          repository: { ...proof.repository, id: String(2_000_000_000 + index) },
        }),
      ).rejects.toMatchObject({
        code: index < 40 ? "UNVERIFIED" : "UNAVAILABLE",
      });
    }
    expect(variedFetch).toHaveBeenCalledTimes(40);
  });

  it("classifies rate limits and transport failures as temporary outages", async () => {
    const rateLimited = new GitHubPublicRepositoryProofVerifier(
      5_000,
      githubFetch({ repositoryStatus: 403 }),
    );
    await expect(rateLimited.verify(proof)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });

    const failed = new GitHubPublicRepositoryProofVerifier(
      5_000,
      vi.fn<typeof fetch>(async () => {
        throw new Error("network details");
      }),
    );
    await expect(failed.verify(proof)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Repository verification is temporarily unavailable",
    });
  });
});
