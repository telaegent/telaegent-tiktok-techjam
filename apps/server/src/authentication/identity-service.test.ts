import { describe, expect, it, vi } from "vitest";
import { GitHubOAuthClient } from "./github-oauth-client.js";
import { TelaegentIdentityService } from "./identity-service.js";
import type {
  CompleteGitHubLoginInput,
  TelaegentIdentityRepository,
} from "./repository.js";
import type { TelaegentWebUser } from "./types.js";

const user: TelaegentWebUser = {
  userId: "10000000-0000-4000-8000-000000000001",
  githubUserId: "9007199254740993",
  githubLogin: "khoa-dao",
  avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
};

class TestRepository implements TelaegentIdentityRepository {
  readonly states = new Map<string, string>();
  readonly sessions = new Map<string, TelaegentWebUser>();
  completedInput: CompleteGitHubLoginInput | null = null;

  async createOAuthState(input: {
    stateHashHex: string;
    returnTo: string;
  }): Promise<void> {
    this.states.set(input.stateHashHex, input.returnTo);
  }

  async consumeOAuthState(stateHashHex: string): Promise<string | null> {
    const returnTo = this.states.get(stateHashHex) ?? null;
    this.states.delete(stateHashHex);
    return returnTo;
  }

  async completeGitHubLogin(input: CompleteGitHubLoginInput): Promise<TelaegentWebUser> {
    this.completedInput = input;
    this.sessions.set(input.sessionTokenHashHex, user);
    return user;
  }

  async loadWebSession(hash: string): Promise<TelaegentWebUser | null> {
    return this.sessions.get(hash) ?? null;
  }

  async revokeWebSession(hash: string): Promise<boolean> {
    return this.sessions.delete(hash);
  }
}

function harness() {
  const repository = new TestRepository();
  const fetchImplementation = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "temporary-oauth-token", token_type: "bearer" }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        '{"login":"khoa-dao","id":9007199254740993,"avatar_url":"https://avatars.githubusercontent.com/u/1?v=4"}',
        { status: 200 },
      ),
    );
  const github = new GitHubOAuthClient(
    "Ov23liabcdefghij",
    "client-secret-not-persisted-123456",
    "https://telaegent.example/api/auth/github/callback",
    5_000,
    fetchImplementation,
  );
  const service = new TelaegentIdentityService(
    repository,
    github,
    Buffer.alloc(32, 7),
    86_400,
  );
  return { repository, fetchImplementation, service };
}

describe("Telaegent GitHub identity sessions", () => {
  it("uses state and PKCE, creates an opaque session, and never persists the OAuth token", async () => {
    const test = harness();
    const started = await test.service.beginGitHubLogin("/app/onboarding");
    const authorization = new URL(started.authorizationUrl);
    const state = authorization.searchParams.get("state");

    expect(authorization.origin).toBe("https://github.com");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("scope")).toBeNull();
    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const completed = await test.service.completeGitHubLogin({
      code: "one-time-code",
      state: state!,
      oauthCookieValue: started.oauthCookieValue,
    });

    expect(completed.user).toEqual(user);
    expect(completed.returnTo).toBe("/app/onboarding");
    expect(completed.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(await test.service.loadSession(completed.sessionToken)).toEqual(user);
    expect(JSON.stringify(test.repository.completedInput)).not.toContain(
      "temporary-oauth-token",
    );
    expect(test.repository.completedInput?.githubUserId).toBe("9007199254740993");

    await test.service.logout(completed.sessionToken);
    expect(await test.service.loadSession(completed.sessionToken)).toBeNull();
  });

  it("fails closed for tampering, replay, unsafe redirects, and malformed sessions", async () => {
    const test = harness();
    const started = await test.service.beginGitHubLogin("https://evil.example/");
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;

    await expect(
      test.service.completeGitHubLogin({
        code: "one-time-code",
        state,
        oauthCookieValue: started.oauthCookieValue + "tampered",
      }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });

    const completed = await test.service.completeGitHubLogin({
      code: "one-time-code",
      state,
      oauthCookieValue: started.oauthCookieValue,
    });
    expect(completed.returnTo).toBe("/app");
    expect(await test.service.loadSession("not-a-session")).toBeNull();

    await expect(
      test.service.completeGitHubLogin({
        code: "another-code",
        state,
        oauthCookieValue: started.oauthCookieValue,
      }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("rejects any OAuth token carrying repository or account scopes", async () => {
    const repository = new TestRepository();
    const github = new GitHubOAuthClient(
      "Ov23liabcdefghij",
      "client-secret-not-persisted-123456",
      "https://telaegent.example/api/auth/github/callback",
      5_000,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "unexpected-scoped-token",
            token_type: "bearer",
            scope: "repo",
          }),
          { status: 200 },
        ),
      ),
    );
    const service = new TelaegentIdentityService(
      repository,
      github,
      Buffer.alloc(32, 7),
      86_400,
    );
    const started = await service.beginGitHubLogin("/");
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;

    await expect(
      service.completeGitHubLogin({
        code: "one-time-code",
        state,
        oauthCookieValue: started.oauthCookieValue,
      }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(repository.completedInput).toBeNull();
  });
});
