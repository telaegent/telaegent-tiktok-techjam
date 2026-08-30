import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { TelaegentIdentityService } from "./identity-service.js";
import type { TelaegentWebUser } from "./types.js";

const user: TelaegentWebUser = {
  userId: "10000000-0000-4000-8000-000000000001",
  githubUserId: "123456",
  githubLogin: "khoa-dao",
  avatarUrl: null,
};

describe("Telaegent identity HTTP routes", () => {
  it("sets hardened cookies, exposes session state, and requires same-origin logout", async () => {
    const logout = vi.fn(async () => undefined);
    const service = {
      beginGitHubLogin: vi.fn(async () => ({
        authorizationUrl:
          "https://github.com/login/oauth/authorize?client_id=test&state=" +
          "s".repeat(43),
        oauthCookieValue: "signed-oauth-cookie",
        oauthCookieMaxAgeSeconds: 600,
      })),
      completeGitHubLogin: vi.fn(async () => ({
        user,
        sessionToken: "t".repeat(43),
        sessionMaxAgeSeconds: 86_400,
        returnTo: "/?view=platform",
      })),
      loadSession: vi.fn(async (token: string | null) =>
        token === "t".repeat(43) ? user : null,
      ),
      logout,
    } as unknown as TelaegentIdentityService;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "legacy-shared-token" }),
      undefined,
      undefined,
      undefined,
      {
        service,
        publicOrigin: "http://localhost:3000",
        secureCookies: false,
      },
    );

    const started = await app.inject({
      method: "GET",
      url: "/api/auth/github/start?returnTo=%2F%3Fview%3Dplatform",
    });
    expect(started.statusCode).toBe(302);
    expect(started.headers.location).toMatch(/^https:\/\/github\.com\//);
    expect(started.headers["set-cookie"]).toContain("HttpOnly");
    expect(started.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(started.headers["set-cookie"]).toContain(
      "Path=/api/auth/github/callback",
    );

    const callback = await app.inject({
      method: "GET",
      url: `/api/auth/github/callback?code=one_time_code&state=${"s".repeat(43)}`,
      headers: { cookie: "telaegent_oauth=signed-oauth-cookie" },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/?view=platform");
    expect(callback.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("telaegent_session=" + "t".repeat(43)),
        expect.stringContaining("telaegent_oauth=; Max-Age=0"),
      ]),
    );

    const session = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: "telaegent_session=" + "t".repeat(43) },
    });
    expect(session.json()).toEqual({ enabled: true, authenticated: true, user });

    const crossSiteLogout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: "https://evil.example",
        cookie: "telaegent_session=" + "t".repeat(43),
      },
    });
    expect(crossSiteLogout.statusCode).toBe(401);
    expect(logout).not.toHaveBeenCalled();

    const sameSiteLogout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: "http://localhost:3000",
        cookie: "telaegent_session=" + "t".repeat(43),
      },
    });
    expect(sameSiteLogout.statusCode).toBe(204);
    expect(logout).toHaveBeenCalledWith("t".repeat(43));
    expect(sameSiteLogout.headers["set-cookie"]).toContain("Max-Age=0");
    await app.close();
  });
});
