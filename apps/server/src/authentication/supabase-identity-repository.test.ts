import { describe, expect, it, vi } from "vitest";
import { SupabaseIdentityRepository } from "./supabase-identity-repository.js";

describe("SupabaseIdentityRepository", () => {
  it("calls only the narrow service-role RPC contract", async () => {
    const secret = "sb_secret_" + "x".repeat(32);
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          userId: "10000000-0000-4000-8000-000000000001",
          githubUserId: "123456",
          githubLogin: "khoa-dao",
          avatarUrl: null,
        }),
        { status: 200 },
      ),
    );
    const repository = new SupabaseIdentityRepository(
      "https://project.supabase.co/",
      secret,
      5_000,
      fetchImplementation,
    );

    const result = await repository.completeGitHubLogin({
      githubUserId: "123456",
      githubLogin: "khoa-dao",
      avatarUrl: null,
      sessionTokenHashHex: "a".repeat(64),
      sessionTtlSeconds: 86_400,
    });

    expect(result?.githubLogin).toBe("khoa-dao");
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(
      "https://project.supabase.co/rest/v1/rpc/complete_github_oauth_login",
    );
    expect(init?.headers).toMatchObject({
      apikey: secret,
    });
    expect(init?.headers).not.toHaveProperty("authorization");
    expect(String(init?.body)).toContain('"p_session_token_hash_hex"');
    expect(String(init?.body)).not.toContain("access_token");
  });

  it("returns a safe retryable error without leaking backend details", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"message":"database internals and supplied input"}', {
        status: 500,
      }),
    );
    const repository = new SupabaseIdentityRepository(
      "https://project.supabase.co",
      "sb_secret_" + "x".repeat(32),
      5_000,
      fetchImplementation,
    );

    await expect(repository.loadWebSession("a".repeat(64))).rejects.toMatchObject({
      code: "AUTHENTICATION_UNAVAILABLE",
      retryable: true,
      message: "Telaegent sign-in is temporarily unavailable",
    });
  });
});
