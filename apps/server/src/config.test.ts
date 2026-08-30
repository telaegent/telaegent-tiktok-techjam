import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("ModelArk configuration", () => {
  it("defaults local runs to the BytePlus Southeast Asia Responses API", () => {
    const config = loadConfig({});

    expect(config.arkBaseUrl).toBe(
      "https://ark.ap-southeast.bytepluses.com/api/v3",
    );
  });

  it("allows an explicit deployment-specific Ark base URL", () => {
    const config = loadConfig({
      ARK_BASE_URL: "https://ark.example.test/api/v3/",
    });

    expect(config.arkBaseUrl).toBe("https://ark.example.test/api/v3");
  });
});

describe("runtime timeout configuration", () => {
  it("defaults to one minute idle and five minutes maximum", () => {
    const config = loadConfig({});

    expect(config.runtimeIdleTimeoutMs).toBe(60_000);
    expect(config.codexTimeoutMs).toBe(300_000);
    expect(config.claudeTimeoutMs).toBe(300_000);
  });

  it("allows deployment-specific timeout limits", () => {
    const config = loadConfig({
      RUNTIME_IDLE_TIMEOUT_MS: "90000",
      CODEX_TIMEOUT_MS: "420000",
      CLAUDE_TIMEOUT_MS: "480000",
    });

    expect(config.runtimeIdleTimeoutMs).toBe(90_000);
    expect(config.codexTimeoutMs).toBe(420_000);
    expect(config.claudeTimeoutMs).toBe(480_000);
  });
});

describe("authorization persistence configuration", () => {
  const secretKey = "sb_secret_" + "a".repeat(32);

  it("keeps supplied Supabase credentials inert unless explicitly selected", () => {
    const config = loadConfig({
      SUPABASE_URL: "https://example-project.supabase.co",
      SUPABASE_SECRET_KEY: secretKey,
    });

    expect(config.authorizationPersistence).toBe("memory");
    expect(config.supabaseUrl).toBe("");
    expect(config.supabaseSecretKey).toBe("");
  });

  it("normalizes a valid backend-only Supabase configuration", () => {
    const config = loadConfig({
      AUTHORIZATION_PERSISTENCE: "supabase",
      SUPABASE_URL: "https://example-project.supabase.co/",
      SUPABASE_SECRET_KEY: secretKey,
    });

    expect(config.authorizationPersistence).toBe("supabase");
    expect(config.supabaseUrl).toBe("https://example-project.supabase.co");
    expect(config.supabaseSecretKey).toBe(secretKey);
    expect(JSON.stringify(config)).not.toContain(secretKey);
  });

  it.each([
    {},
    { SUPABASE_URL: "http://example-project.supabase.co", SUPABASE_SECRET_KEY: secretKey },
    {
      SUPABASE_URL: "https://example-project.supabase.co",
      SUPABASE_SECRET_KEY: "sb_publishable_" + "a".repeat(32),
    },
  ])("rejects missing or unsafe selected Supabase configuration", (candidate) => {
    expect(() =>
      loadConfig({
        AUTHORIZATION_PERSISTENCE: "supabase",
        ...candidate,
      }),
    ).toThrow("Supabase backend persistence configuration is invalid");
  });
});

describe("GitHub-backed Telaegent identity configuration", () => {
  const secretKey = "sb_secret_" + "a".repeat(32);
  const cookieSecret = "a".repeat(43);

  it("keeps identity credentials inert unless GitHub identity is explicitly enabled", () => {
    const config = loadConfig({
      SUPABASE_URL: "https://example-project.supabase.co",
      SUPABASE_SECRET_KEY: secretKey,
      TELAEGENT_PUBLIC_URL: "https://telaegent.example",
      TELAEGENT_COOKIE_SECRET: cookieSecret,
      GITHUB_OAUTH_CLIENT_ID: "Ov23liabcdefghij",
      GITHUB_OAUTH_CLIENT_SECRET: "b".repeat(40),
    });

    expect(config.telaegentIdentityProvider).toBe("disabled");
    expect(config.telaegentPublicOrigin).toBe("");
    expect(config.supabaseUrl).toBe("");
  });

  it("normalizes GitHub OAuth and backend-only Supabase persistence", () => {
    const config = loadConfig({
      TELAEGENT_IDENTITY_PROVIDER: "github",
      TELAEGENT_PUBLIC_URL: "https://telaegent.example/",
      TELAEGENT_COOKIE_SECRET: cookieSecret,
      GITHUB_OAUTH_CLIENT_ID: "Ov23liabcdefghij",
      GITHUB_OAUTH_CLIENT_SECRET: "b".repeat(40),
      SUPABASE_URL: "https://example-project.supabase.co/",
      SUPABASE_SECRET_KEY: secretKey,
      GITHUB_OAUTH_TIMEOUT_MS: "2500",
    });

    expect(config.telaegentIdentityProvider).toBe("github");
    expect(config.telaegentPublicOrigin).toBe("https://telaegent.example");
    expect(config.githubOAuthTimeoutMs).toBe(2500);
    expect(config.supabaseUrl).toBe("https://example-project.supabase.co");
    expect(config.supabaseSecretKey).toBe(secretKey);
    expect(JSON.stringify(config)).not.toContain(secretKey);
    expect(JSON.stringify(config)).not.toContain("b".repeat(40));
  });

  it.each([
    {},
    {
      TELAEGENT_PUBLIC_URL: "http://telaegent.example",
      TELAEGENT_COOKIE_SECRET: cookieSecret,
      GITHUB_OAUTH_CLIENT_ID: "Ov23liabcdefghij",
      GITHUB_OAUTH_CLIENT_SECRET: "b".repeat(40),
      SUPABASE_URL: "https://example-project.supabase.co",
      SUPABASE_SECRET_KEY: secretKey,
    },
    {
      TELAEGENT_PUBLIC_URL: "https://telaegent.example",
      TELAEGENT_COOKIE_SECRET: "too-short",
      GITHUB_OAUTH_CLIENT_ID: "Ov23liabcdefghij",
      GITHUB_OAUTH_CLIENT_SECRET: "b".repeat(40),
      SUPABASE_URL: "https://example-project.supabase.co",
      SUPABASE_SECRET_KEY: secretKey,
    },
  ])("rejects incomplete or unsafe enabled GitHub identity", (candidate) => {
    expect(() =>
      loadConfig({
        TELAEGENT_IDENTITY_PROVIDER: "github",
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        ...candidate,
      }),
    ).toThrow();
  });
});
