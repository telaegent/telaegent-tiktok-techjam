import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { setPrivateNoStore } from "../http-cache.js";
import type { TelaegentIdentityService } from "./identity-service.js";
import { UserAuthenticationError } from "./types.js";

const startQuerySchema = z.object({ returnTo: z.string().max(512).optional() });
const callbackQuerySchema = z.object({
  code: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/),
  state: z.string().min(40).max(128).regex(/^[A-Za-z0-9_-]+$/),
});

export interface IdentityRouteDependencies {
  service: TelaegentIdentityService;
  publicOrigin: string;
  secureCookies: boolean;
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  dependencies: IdentityRouteDependencies,
): void {
  const sessionCookieName = dependencies.secureCookies
    ? "__Host-telaegent_session"
    : "telaegent_session";
  const oauthCookieName = dependencies.secureCookies
    ? "__Secure-telaegent_oauth"
    : "telaegent_oauth";

  app.get("/api/auth/session", async (request, reply) => {
    setPrivateNoStore(reply);
    const user = await dependencies.service.loadSession(
      readCookie(request, sessionCookieName),
    );
    return user ? { enabled: true, authenticated: true, user } : {
      enabled: true,
      authenticated: false,
    };
  });

  app.get("/api/auth/github/start", async (request, reply) => {
    setPrivateNoStore(reply);
    const query = startQuerySchema.parse(request.query);
    const login = await dependencies.service.beginGitHubLogin(query.returnTo);
    reply.header(
      "set-cookie",
      serializeCookie(oauthCookieName, login.oauthCookieValue, {
        maxAge: login.oauthCookieMaxAgeSeconds,
        path: "/api/auth/github/callback",
        secure: dependencies.secureCookies,
      }),
    );
    return reply.redirect(login.authorizationUrl, 302);
  });

  app.get("/api/auth/github/callback", async (request, reply) => {
    setPrivateNoStore(reply);
    const query = callbackQuerySchema.parse(request.query);
    const completed = await dependencies.service.completeGitHubLogin({
      ...query,
      oauthCookieValue: readCookie(request, oauthCookieName),
    });
    reply.header("set-cookie", [
      serializeCookie(oauthCookieName, "", {
        maxAge: 0,
        path: "/api/auth/github/callback",
        secure: dependencies.secureCookies,
      }),
      serializeCookie(sessionCookieName, completed.sessionToken, {
        maxAge: completed.sessionMaxAgeSeconds,
        path: "/",
        secure: dependencies.secureCookies,
      }),
    ]);
    return reply.redirect(completed.returnTo, 302);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    setPrivateNoStore(reply);
    enforceSameOrigin(request, dependencies.publicOrigin);
    await dependencies.service.logout(readCookie(request, sessionCookieName));
    reply.header(
      "set-cookie",
      serializeCookie(sessionCookieName, "", {
        maxAge: 0,
        path: "/",
        secure: dependencies.secureCookies,
      }),
    );
    return reply.code(204).send();
  });
}

export function createAuthenticatedUserResolver(
  service: TelaegentIdentityService,
  secureCookies: boolean,
  publicOrigin: string,
): (request: FastifyRequest) => Promise<string> {
  const cookieName = secureCookies
    ? "__Host-telaegent_session"
    : "telaegent_session";
  return async (request) => {
    if (!new Set(["GET", "HEAD", "OPTIONS"]).has(request.method)) {
      enforceSameOrigin(request, publicOrigin);
    }
    const user = await service.loadSession(readCookie(request, cookieName));
    if (!user) {
      throw new UserAuthenticationError(
        "AUTHENTICATION_REQUIRED",
        "Authentication required",
      );
    }
    return user.userId;
  };
}

function enforceSameOrigin(request: FastifyRequest, publicOrigin: string): void {
  if (request.headers.origin !== publicOrigin) {
    throw new UserAuthenticationError(
      "AUTHENTICATION_FAILED",
      "Request origin is not allowed",
    );
  }
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header || header.length > 8_192) return null;
  let result: string | null = null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1 || item.slice(0, separator).trim() !== name) continue;
    if (result !== null) return null;
    result = item.slice(separator + 1).trim();
  }
  return result;
}

function serializeCookie(
  name: string,
  value: string,
  options: { maxAge: number; path: string; secure: boolean },
): string {
  return [
    `${name}=${value}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    `Path=${options.path}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}
