import { z } from "zod";
import type {
  CompleteGitHubLoginInput,
  TelaegentIdentityRepository,
} from "./repository.js";
import {
  telaegentWebUserSchema,
  type TelaegentWebUser,
  UserAuthenticationError,
} from "./types.js";

const RPC_RESPONSE_LIMIT_BYTES = 16_384;
const nullableStringSchema = z.string().min(1).max(512).nullable();

export class SupabaseIdentityRepository implements TelaegentIdentityRepository {
  private readonly baseUrl: string;

  constructor(
    url: string,
    private readonly secretKey: string,
    private readonly timeoutMs: number,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.baseUrl = url.replace(/\/+$/, "") + "/rest/v1/rpc/";
  }

  async createOAuthState(input: {
    stateHashHex: string;
    returnTo: string;
  }): Promise<void> {
    await this.rpc("create_github_oauth_state", {
      p_state_hash_hex: input.stateHashHex,
      p_return_to: input.returnTo,
    });
  }

  async consumeOAuthState(stateHashHex: string): Promise<string | null> {
    const value = await this.rpc("consume_github_oauth_state", {
      p_state_hash_hex: stateHashHex,
    });
    return nullableStringSchema.parse(value);
  }

  async completeGitHubLogin(
    input: CompleteGitHubLoginInput,
  ): Promise<TelaegentWebUser | null> {
    const value = await this.rpc("complete_github_oauth_login", {
      p_github_user_id: input.githubUserId,
      p_github_login: input.githubLogin,
      p_avatar_url: input.avatarUrl,
      p_session_token_hash_hex: input.sessionTokenHashHex,
      p_session_ttl_seconds: input.sessionTtlSeconds,
    });
    return value === null ? null : telaegentWebUserSchema.parse(value);
  }

  async loadWebSession(sessionTokenHashHex: string): Promise<TelaegentWebUser | null> {
    const value = await this.rpc("load_telaegent_web_session", {
      p_session_token_hash_hex: sessionTokenHashHex,
    });
    return value === null ? null : telaegentWebUserSchema.parse(value);
  }

  async revokeWebSession(sessionTokenHashHex: string): Promise<boolean> {
    return z.boolean().parse(
      await this.rpc("revoke_telaegent_web_session", {
        p_session_token_hash_hex: sessionTokenHashHex,
      }),
    );
  }

  private async rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.fetchImplementation(this.baseUrl + name, {
        method: "POST",
        headers: {
          apikey: this.secretKey,
          "content-type": "application/json",
          accept: "application/json",
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
      // Deliberately do not read/log PostgREST details: they can contain input.
      throw unavailable();
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > RPC_RESPONSE_LIMIT_BYTES) {
      throw unavailable();
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > RPC_RESPONSE_LIMIT_BYTES) {
      throw unavailable();
    }
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw unavailable();
    }
  }
}

function unavailable(): UserAuthenticationError {
  return new UserAuthenticationError(
    "AUTHENTICATION_UNAVAILABLE",
    "Telaegent sign-in is temporarily unavailable",
    503,
  );
}
