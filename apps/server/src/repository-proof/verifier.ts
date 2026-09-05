import { z } from "zod";
import type { RepositoryProof } from "./contract.js";

const MAX_GITHUB_RESPONSE_BYTES = 65_536;
// Connector proofs refresh every five minutes. A slightly shorter successful
// response cache coalesces a team's refresh wave without extending the
// authorization freshness window or caching denials/outages.
const SUCCESS_CACHE_TTL_MS = 4 * 60 * 1_000;
const DENIAL_CACHE_TTL_MS = 60 * 1_000;
const MAX_SUCCESS_CACHE_ENTRIES = 512;
// GitHub grants an originating IP only 60 anonymous requests/hour. Keep a
// deployment-local reserve for recovery/manual traffic and fail closed before
// an authenticated caller can consume the whole allowance.
const MAX_ANONYMOUS_REQUESTS_PER_HOUR = 40;
const githubLoginSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);
const repositoryNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/);
const repositorySchema = z
  .object({
    name: repositoryNameSchema,
    owner: z.object({ login: githubLoginSchema }),
    private: z.literal(false),
    visibility: z.literal("public"),
    default_branch: z.string().min(1).max(255),
  })
  .passthrough();

export interface VerifiedRepositoryAccess {
  github: RepositoryProof["github"];
  repository: Pick<
    RepositoryProof["repository"],
    "id" | "owner" | "name" | "visibility" | "defaultBranch" | "permission"
  >;
}

export interface RepositoryProofVerifier {
  verify(proof: Readonly<RepositoryProof>): Promise<VerifiedRepositoryAccess>;
}

export class RepositoryProofVerificationError extends Error {
  constructor(readonly code: "UNVERIFIED" | "UNAVAILABLE") {
    super(
      code === "UNVERIFIED"
        ? "Repository access could not be independently verified"
        : "Repository verification is temporarily unavailable",
    );
    this.name = "RepositoryProofVerificationError";
  }
}

/**
 * Credential-free independent verification for public GitHub repositories.
 *
 * Private/internal access cannot be independently established without giving
 * the cloud a GitHub credential or installing a GitHub App. Both contradict
 * the current local-custody architecture, so those proofs fail closed instead
 * of being promoted into memberships from a connector assertion.
 */
export class GitHubPublicRepositoryProofVerifier
  implements RepositoryProofVerifier
{
  private readonly successes = new Map<
    string,
    Readonly<{ text: string; expiresAt: number }>
  >();
  private readonly denials = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly requestTimes: number[] = [];
  private githubRemaining: number | null = null;
  private githubResetAt = 0;

  constructor(
    private readonly timeoutMs: number,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
      throw new Error("GitHub repository verifier configuration is invalid");
    }
  }

  async verify(
    proof: Readonly<RepositoryProof>,
  ): Promise<VerifiedRepositoryAccess> {
    if (proof.repository.visibility !== "public") {
      throw new RepositoryProofVerificationError("UNVERIFIED");
    }

    // The service has already bound proof.github.userId to the authenticated
    // account in Supabase. Only repository existence and immutable identity
    // need GitHub here, reducing a proof from two anonymous calls to one.
    const repositoryText = await this.fetchGitHub(
      `https://api.github.com/repositories/${proof.repository.id}`,
    );
    const repository = repositorySchema.safeParse(parseJson(repositoryText));
    const githubRepositoryId = extractTopLevelPositiveInteger(repositoryText, "id");
    if (
      !repository.success ||
      githubRepositoryId !== proof.repository.id ||
      repository.data.owner.login.toLowerCase() !==
        proof.repository.owner.toLowerCase() ||
      repository.data.name.toLowerCase() !== proof.repository.name.toLowerCase()
    ) {
      throw new RepositoryProofVerificationError("UNVERIFIED");
    }

    return {
      github: proof.github,
      repository: {
        id: githubRepositoryId,
        owner: repository.data.owner.login,
        name: repository.data.name,
        visibility: "public",
        defaultBranch: repository.data.default_branch,
        // Anonymous GitHub verification proves public read access and no more.
        // A connector's self-reported write/admin permission is never promoted.
        permission: "read",
      },
    };
  }

  private async fetchGitHub(url: string): Promise<string> {
    const now = Date.now();
    const cached = this.successes.get(url);
    if (cached && cached.expiresAt > now) return cached.text;
    if (cached) this.successes.delete(url);
    const deniedUntil = this.denials.get(url);
    if (deniedUntil && deniedUntil > now) {
      throw new RepositoryProofVerificationError("UNVERIFIED");
    }
    if (deniedUntil) this.denials.delete(url);
    const pending = this.inFlight.get(url);
    if (pending) return pending;

    this.reserveAnonymousRequest(now);
    const request = this.fetchGitHubUncached(url).then(
      (text) => {
        if (this.successes.size >= MAX_SUCCESS_CACHE_ENTRIES) {
          const oldest = this.successes.keys().next().value as string | undefined;
          if (oldest) this.successes.delete(oldest);
        }
        this.successes.set(url, {
          text,
          expiresAt: Date.now() + SUCCESS_CACHE_TTL_MS,
        });
        return text;
      },
      (error: unknown) => {
        if (
          error instanceof RepositoryProofVerificationError &&
          error.code === "UNVERIFIED"
        ) {
          if (this.denials.size >= MAX_SUCCESS_CACHE_ENTRIES) {
            const oldest = this.denials.keys().next().value as string | undefined;
            if (oldest) this.denials.delete(oldest);
          }
          this.denials.set(url, Date.now() + DENIAL_CACHE_TTL_MS);
        }
        throw error;
      },
    );
    this.inFlight.set(url, request);
    try {
      return await request;
    } finally {
      if (this.inFlight.get(url) === request) this.inFlight.delete(url);
    }
  }

  private reserveAnonymousRequest(now: number): void {
    while (this.requestTimes[0] !== undefined && this.requestTimes[0] <= now - 3_600_000) {
      this.requestTimes.shift();
    }
    if (
      this.requestTimes.length >= MAX_ANONYMOUS_REQUESTS_PER_HOUR ||
      (this.githubRemaining !== null && this.githubRemaining <= 1 && this.githubResetAt > now)
    ) {
      throw new RepositoryProofVerificationError("UNAVAILABLE");
    }
    this.requestTimes.push(now);
  }

  private async fetchGitHubUncached(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImplementation(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "Telaegent",
          "x-github-api-version": "2022-11-28",
        },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      const remaining = Number(response.headers.get("x-ratelimit-remaining"));
      const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
      if (Number.isSafeInteger(remaining) && remaining >= 0) {
        this.githubRemaining = remaining;
      }
      if (Number.isSafeInteger(resetSeconds) && resetSeconds > 0) {
        this.githubResetAt = resetSeconds * 1_000;
      }
      if (response.status === 404) {
        await response.body?.cancel();
        throw new RepositoryProofVerificationError("UNVERIFIED");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new RepositoryProofVerificationError("UNAVAILABLE");
      }
      return await readBounded(response);
    } catch (error) {
      if (error instanceof RepositoryProofVerificationError) throw error;
      throw new RepositoryProofVerificationError("UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_GITHUB_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new RepositoryProofVerificationError("UNAVAILABLE");
  }
  if (!response.body) throw new RepositoryProofVerificationError("UNAVAILABLE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_GITHUB_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RepositoryProofVerificationError("UNAVAILABLE");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new RepositoryProofVerificationError("UNAVAILABLE");
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RepositoryProofVerificationError("UNAVAILABLE");
  }
}

// JSON.parse rounds GitHub integer IDs above 2^53, so IDs are extracted from
// their top-level numeric token and remain decimal strings end to end.
function extractTopLevelPositiveInteger(
  json: string,
  wantedKey: string,
): string | null {
  let depth = 0;
  let index = 0;
  while (index < json.length) {
    const character = json[index];
    if (character === '"') {
      const start = ++index;
      while (index < json.length && json[index] !== '"') {
        if (json[index] === "\\") return null;
        index += 1;
      }
      const value = json.slice(start, index);
      index += 1;
      if (depth === 1 && value === wantedKey) {
        while (/\s/.test(json[index] ?? "")) index += 1;
        if (json[index] !== ":") continue;
        index += 1;
        while (/\s/.test(json[index] ?? "")) index += 1;
        const match = /^(?:[1-9]\d{0,18})/.exec(json.slice(index));
        if (!match) return null;
        try {
          return BigInt(match[0]) <= 9_223_372_036_854_775_807n
            ? match[0]
            : null;
        } catch {
          return null;
        }
      }
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    index += 1;
  }
  return null;
}
