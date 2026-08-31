import { z } from "zod";
import { UserAuthenticationError } from "./types.js";

const MAX_RESPONSE_BYTES = 65_536;
const githubProfileSchema = z
  .object({
    login: z
      .string()
      .min(1)
      .max(39)
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
    avatar_url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => value.startsWith("https://"))
      .nullable(),
  })
  .passthrough();
const tokenSchema = z
  .object({
    access_token: z.string().min(1).max(2_048),
    token_type: z.string().max(32),
    scope: z.string().max(1_024).optional(),
  })
  .passthrough();

export interface GitHubIdentity {
  githubUserId: string;
  githubLogin: string;
  avatarUrl: string | null;
}

export class GitHubOAuthClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly callbackUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  authorizationUrl(state: string, codeChallenge: string): string {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.callbackUrl);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    // No repository scope: cloud sign-in proves account identity only.
    return url.toString();
  }

  async authenticate(code: string, codeVerifier: string): Promise<GitHubIdentity> {
    const tokenResponse = await this.fetchBounded(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "Telaegent",
        },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code,
          redirect_uri: this.callbackUrl,
          code_verifier: codeVerifier,
        }),
      },
    );
    const token = tokenSchema.safeParse(parseJson(tokenResponse));
    if (
      !token.success ||
      token.data.token_type.toLowerCase() !== "bearer" ||
      (token.data.scope ?? "").trim().length > 0
    ) {
      throw failed();
    }

    const userResponse = await this.fetchBounded("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token.data.access_token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "Telaegent",
      },
    });
    const profile = githubProfileSchema.safeParse(parseJson(userResponse));
    const githubUserId = extractTopLevelPositiveInteger(userResponse, "id");
    if (!profile.success || githubUserId === null) throw failed();
    return {
      githubUserId,
      githubLogin: profile.data.login,
      avatarUrl: profile.data.avatar_url,
    };
  }

  private async fetchBounded(url: string, init: RequestInit): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImplementation(url, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw failed();
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw failed();
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw failed();
      return text;
    } catch (error) {
      if (error instanceof UserAuthenticationError) throw error;
      throw failed();
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw failed();
  }
}

// JSON.parse rounds integers above 2^53. GitHub IDs are stored as Postgres
// BIGINT text, so scan the top-level numeric token without losing precision.
function extractTopLevelPositiveInteger(json: string, wantedKey: string): string | null {
  let depth = 0;
  let index = 0;
  while (index < json.length) {
    const character = json[index];
    if (character === '"') {
      const start = ++index;
      let value = "";
      while (index < json.length && json[index] !== '"') {
        if (json[index] === "\\") return null;
        index += 1;
      }
      value = json.slice(start, index);
      index += 1;
      if (depth === 1 && value === wantedKey) {
        while (/\s/.test(json[index] ?? "")) index += 1;
        if (json[index] !== ":") continue;
        index += 1;
        while (/\s/.test(json[index] ?? "")) index += 1;
        const match = /^(?:[1-9]\d{0,18})/.exec(json.slice(index));
        if (!match) return null;
        try {
          return BigInt(match[0]) <= 9_223_372_036_854_775_807n ? match[0] : null;
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

function failed(): UserAuthenticationError {
  return new UserAuthenticationError(
    "AUTHENTICATION_FAILED",
    "GitHub sign-in could not be completed",
  );
}
