import { describe, expect, it, vi } from "vitest";
import { SupabaseProjectRepository } from "./supabase-repository.js";

const input = {
  authenticatedUserId: "10000000-0000-4000-8000-000000000001",
  afterGitHubRepositoryId: "123",
  limit: 21,
};

describe("SupabaseProjectRepository", () => {
  it("calls only the owner-scoped project RPC with bounded parameters", async () => {
    const fetchImplementation = vi.fn(async () => new Response("[]", { status: 200 }));
    const repository = new SupabaseProjectRepository(
      "https://example.supabase.co",
      `sb_secret_${"a".repeat(32)}`,
      1_000,
      fetchImplementation,
    );
    await expect(repository.listForUser(input)).resolves.toEqual([]);
    const [url, request] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe("https://example.supabase.co/rest/v1/rpc/list_user_projects");
    expect(JSON.parse(String(request?.body))).toEqual({
      p_user_id: input.authenticatedUserId,
      p_after_github_repository_id: input.afterGitHubRepositoryId,
      p_limit: input.limit,
    });
    expect(request).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  });

  it("collapses invalid or oversized database responses to a safe 503", async () => {
    const fetchImplementation = vi.fn(async () => new Response(
      JSON.stringify([{ localPath: "C:/private/repository" }]),
      { status: 200 },
    ));
    const repository = new SupabaseProjectRepository(
      "https://example.supabase.co",
      `sb_secret_${"b".repeat(32)}`,
      1_000,
      fetchImplementation,
    );
    await expect(repository.listForUser(input)).rejects.toMatchObject({
      statusCode: 503,
      message: "Project discovery is temporarily unavailable",
    });
  });
});
