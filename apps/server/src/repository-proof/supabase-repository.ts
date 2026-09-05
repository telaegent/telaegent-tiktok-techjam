import { z } from "zod";
import {
  repositoryProofResultSchema,
  repositoryUnavailableResultSchema,
  type RepositoryProofResult,
  type RepositoryUnavailableResult,
} from "./contract.js";
import type {
  MarkRepositoryUnavailableCommand,
  RegisterRepositoryProofCommand,
  RepositoryProofRepository,
} from "./repository.js";
import { RepositoryProofError } from "./service.js";
import { isSafeSupabaseOrigin } from "../supabase-origin.js";

const responseLimitBytes = 16_384;
const secretKeyPattern = /^sb_secret_[A-Za-z0-9_-]{20,480}$/;
const policyDenialSchema = z.strictObject({
  error: z.enum([
    "account_inactive",
    "github_identity_mismatch",
    "github_connection_revoked",
    "repository_access_revoked",
    "project_archived",
    "membership_revoked",
    "binding_revoked",
    "proof_id_conflict",
    "stale_observation",
    "binding_not_owned",
  ]),
});

export class SupabaseRepositoryProofRepository
  implements RepositoryProofRepository
{
  private readonly rpcBaseUrl: string;

  constructor(
    supabaseUrl: string,
    private readonly secretKey: string,
    private readonly timeoutMs: number,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.rpcBaseUrl = validateConfig(supabaseUrl, secretKey);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
      throw configurationError();
    }
  }

  async authorizeProofIdentity(
    principal: Readonly<RegisterRepositoryProofCommand["principal"]>,
    github: Readonly<RegisterRepositoryProofCommand["proof"]["github"]>,
  ): Promise<void> {
    const value = await this.rpc("authorize_local_github_proof_identity", {
      p_user_id: principal.authenticatedUserId,
      p_connector_instance_id: principal.connectorInstanceId,
      p_github_user_id: github.userId,
    });
    const parsed = z.strictObject({ outcome: z.literal("authorized") }).safeParse(value);
    if (parsed.success) return;
    const denial = policyDenialSchema.safeParse(value);
    if (denial.success) {
      throw new RepositoryProofError(
        "REPOSITORY_PROOF_FORBIDDEN",
        "Repository proof is not authorized",
        403,
      );
    }
    throw unavailable();
  }

  async registerRepositoryProof(
    command: Readonly<RegisterRepositoryProofCommand>,
  ): Promise<RepositoryProofResult> {
    const proof = command.proof;
    const value = await this.rpc("register_local_github_repository_proof", {
      p_user_id: command.principal.authenticatedUserId,
      p_connector_instance_id: command.principal.connectorInstanceId,
      p_proof_id: proof.proofId,
      p_payload_digest_hex: command.payloadDigestHex,
      p_observed_at: proof.observedAt,
      p_github_user_id: proof.github.userId,
      p_github_login: proof.github.login,
      p_github_repository_id: proof.repository.id,
      p_repository_full_name: command.repositoryFullName,
      p_visibility: proof.repository.visibility,
      p_default_branch: proof.repository.defaultBranch,
      p_current_branch: proof.repository.currentBranch,
      p_commit_sha: proof.repository.commitSha,
      p_permission: proof.repository.permission,
    });
    return parseResult(value, repositoryProofResultSchema);
  }

  async markRepositoryUnavailable(
    command: Readonly<MarkRepositoryUnavailableCommand>,
  ): Promise<RepositoryUnavailableResult> {
    const value = await this.rpc("mark_local_github_repository_unavailable", {
      p_user_id: command.principal.authenticatedUserId,
      p_connector_instance_id: command.principal.connectorInstanceId,
      p_github_repository_id: command.githubRepositoryId,
      p_observed_at: command.event.observedAt,
      p_reason: command.event.reason,
    });
    return parseResult(value, repositoryUnavailableResultSchema);
  }

  private async rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.fetchImplementation(this.rpcBaseUrl + name, {
        method: "POST",
        headers: {
          accept: "application/json",
          apikey: this.secretKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
    } catch {
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // PostgREST details can echo request data. Never propagate or log them.
      await discardBody(response);
      throw unavailable();
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > responseLimitBytes) {
      await discardBody(response);
      throw unavailable();
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > responseLimitBytes) throw unavailable();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw unavailable();
    }
  }
}

function parseResult<T>(value: unknown, schema: z.ZodType<T>): T {
  const denial = policyDenialSchema.safeParse(value);
  if (denial.success) {
    const conflict = new Set([
      "proof_id_conflict",
      "stale_observation",
    ]).has(denial.data.error);
    throw new RepositoryProofError(
      conflict ? "REPOSITORY_PROOF_CONFLICT" : "REPOSITORY_PROOF_FORBIDDEN",
      conflict
        ? "Repository proof conflicts with current state"
        : "Repository proof is not authorized",
      conflict ? 409 : 403,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

function validateConfig(urlValue: string, secretKey: string): string {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw configurationError();
  }
  if (!isSafeSupabaseOrigin(url) || !secretKeyPattern.test(secretKey)) {
    throw configurationError();
  }
  return url.origin + "/rest/v1/rpc/";
}

function configurationError(): Error {
  return new Error("Repository proof persistence configuration is invalid");
}

function unavailable(): RepositoryProofError {
  return new RepositoryProofError(
    "REPOSITORY_PROOF_UNAVAILABLE",
    "Repository proof service is temporarily unavailable",
    503,
  );
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup only.
  }
}
