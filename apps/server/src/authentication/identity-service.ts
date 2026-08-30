import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { GitHubOAuthClient } from "./github-oauth-client.js";
import type { TelaegentIdentityRepository } from "./repository.js";
import {
  type TelaegentWebUser,
  UserAuthenticationError,
} from "./types.js";

const OAUTH_LIFETIME_MS = 10 * 60 * 1_000;
const OAUTH_PAYLOAD_VERSION = 1;

interface OAuthCookiePayload {
  v: 1;
  state: string;
  verifier: string;
  expiresAt: number;
}

export class TelaegentIdentityService {
  constructor(
    private readonly repository: TelaegentIdentityRepository,
    private readonly github: GitHubOAuthClient,
    private readonly cookieSecret: Buffer,
    private readonly sessionTtlSeconds: number,
  ) {}

  async beginGitHubLogin(returnToCandidate: string | undefined): Promise<{
    authorizationUrl: string;
    oauthCookieValue: string;
    oauthCookieMaxAgeSeconds: number;
  }> {
    const returnTo = safeReturnTo(returnToCandidate);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + OAUTH_LIFETIME_MS;
    await this.repository.createOAuthState({
      stateHashHex: sha256Hex(state),
      returnTo,
    });
    return {
      authorizationUrl: this.github.authorizationUrl(
        state,
        createHash("sha256").update(verifier).digest("base64url"),
      ),
      oauthCookieValue: this.signOAuthPayload({
        v: OAUTH_PAYLOAD_VERSION,
        state,
        verifier,
        expiresAt,
      }),
      oauthCookieMaxAgeSeconds: OAUTH_LIFETIME_MS / 1_000,
    };
  }

  async completeGitHubLogin(input: {
    code: string;
    state: string;
    oauthCookieValue: string | null;
  }): Promise<{
    user: TelaegentWebUser;
    sessionToken: string;
    sessionMaxAgeSeconds: number;
    returnTo: string;
  }> {
    const payload = this.verifyOAuthPayload(input.oauthCookieValue);
    if (
      payload.expiresAt <= Date.now() ||
      !constantTimeTextEqual(payload.state, input.state)
    ) {
      throw failed();
    }
    const returnTo = await this.repository.consumeOAuthState(sha256Hex(input.state));
    if (returnTo === null) throw failed();

    const githubIdentity = await this.github.authenticate(input.code, payload.verifier);
    const sessionToken = randomBytes(32).toString("base64url");
    const user = await this.repository.completeGitHubLogin({
      ...githubIdentity,
      sessionTokenHashHex: sha256Hex(sessionToken),
      sessionTtlSeconds: this.sessionTtlSeconds,
    });
    if (user === null) throw failed();
    return {
      user,
      sessionToken,
      sessionMaxAgeSeconds: this.sessionTtlSeconds,
      returnTo: safeReturnTo(returnTo),
    };
  }

  async loadSession(rawSessionToken: string | null): Promise<TelaegentWebUser | null> {
    if (!isOpaqueToken(rawSessionToken)) return null;
    return this.repository.loadWebSession(sha256Hex(rawSessionToken));
  }

  async logout(rawSessionToken: string | null): Promise<void> {
    if (isOpaqueToken(rawSessionToken)) {
      await this.repository.revokeWebSession(sha256Hex(rawSessionToken));
    }
  }

  private signOAuthPayload(payload: OAuthCookiePayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return encoded + "." + this.signature(encoded);
  }

  private verifyOAuthPayload(value: string | null): OAuthCookiePayload {
    if (!value || value.length > 1_024) throw failed();
    const parts = value.split(".");
    if (parts.length !== 2 || !constantTimeTextEqual(parts[1]!, this.signature(parts[0]!))) {
      throw failed();
    }
    try {
      const parsed = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as {
        v?: unknown;
        state?: unknown;
        verifier?: unknown;
        expiresAt?: unknown;
      };
      if (
        parsed.v !== OAUTH_PAYLOAD_VERSION ||
        !isOpaqueToken(parsed.state) ||
        !isOpaqueToken(parsed.verifier) ||
        typeof parsed.expiresAt !== "number" ||
        !Number.isSafeInteger(parsed.expiresAt)
      ) {
        throw failed();
      }
      return parsed as OAuthCookiePayload;
    } catch (error) {
      if (error instanceof UserAuthenticationError) throw error;
      throw failed();
    }
  }

  private signature(encodedPayload: string): string {
    return createHmac("sha256", this.cookieSecret)
      .update(encodedPayload)
      .digest("base64url");
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function isOpaqueToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,128}$/.test(value);
}

function safeReturnTo(value: string | undefined): string {
  if (
    value &&
    value.length <= 512 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !/[\r\n]/.test(value)
  ) {
    return value;
  }
  return "/?view=platform";
}

function failed(): UserAuthenticationError {
  return new UserAuthenticationError(
    "AUTHENTICATION_FAILED",
    "GitHub sign-in could not be completed",
  );
}
