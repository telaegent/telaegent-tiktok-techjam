import { describe, expect, it } from "vitest";
import { FakeSessionRepository } from "../../src/auth/fake-session-repository";
import { SessionService } from "../../src/auth/session";
import { StubGoogleOAuthProvider } from "../../src/auth/oauth";
import { handleLogin } from "../../src/routes/login";
import { handleOAuthCallback } from "../../src/routes/oauth-callback";

const provider = new StubGoogleOAuthProvider({
  "good-code": {
    subject: "42",
    email: "alice@example.test",
    displayName: "Alice Example",
  },
});

describe("OAuth login", () => {
  it("redirects to the provider with the supplied state", () => {
    const response = handleLogin(provider, "state-123");
    expect(response.status).toBe(302);
    expect(response.location).toContain("state-123");
  });
});

describe("OAuth callback", () => {
  it("starts a session for a valid code", async () => {
    const sessions = new SessionService(new FakeSessionRepository());
    const result = await handleOAuthCallback({ code: "good-code" }, provider, sessions);

    expect(result.status).toBe(200);
    expect(result.sessionId).toBeDefined();
    expect(result.user?.email).toBe("alice@example.test");
  });

  it("passes the device through to the session when the client sends one", async () => {
    const repository = new FakeSessionRepository();
    const sessions = new SessionService(repository);
    const result = await handleOAuthCallback(
      { code: "good-code", deviceId: "device-xyz" },
      provider,
      sessions,
    );

    const session = await repository.find(result.sessionId ?? "");
    expect(session?.deviceId).toBe("device-xyz");
  });

  it("rejects an unknown code without creating a session", async () => {
    const repository = new FakeSessionRepository();
    const sessions = new SessionService(repository);

    const result = await handleOAuthCallback({ code: "bad-code" }, provider, sessions);

    expect(result.status).toBe(401);
    expect(repository.size).toBe(0);
  });
});
