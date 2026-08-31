import { describe, expect, it, vi } from "vitest";
import { SupabaseAuthorizationRpcClient } from "./supabase-authorization-client.js";
import { SupabasePrivateRuntimeAuthorizationRepository } from "./supabase-authorization-repository.js";

const endpoint =
  "https://example-project.supabase.co/rest/v1/rpc/load_private_runtime_authorization_snapshot";
const secretKey = "sb_secret_" + "a".repeat(32);
const request = {
  authenticatedUserId: "aaaaaaaa-0000-4000-8000-000000000001",
  githubRepositoryId: "9223372036854775807",
  conversationId: "bbbbbbbb-0000-4000-8000-000000000002",
  maximumProjectConnections: 15,
} as const;

function client(fetchImplementation: typeof fetch) {
  return new SupabaseAuthorizationRpcClient({
    supabaseUrl: "https://example-project.supabase.co/",
    secretKey,
    fetch: fetchImplementation,
  });
}

describe("SupabaseAuthorizationRpcClient", () => {
  it("calls the backend-only RPC with precision-safe parameters and forwards abort", async () => {
    const payload = { user: null, projectConnections: [] };
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      Response.json(payload),
    );
    const controller = new AbortController();

    await expect(
      client(fetchImplementation).fetchPrivateRuntimeAuthorizationSnapshot(
        request,
        { signal: controller.signal },
      ),
    ).resolves.toEqual(payload);

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("apikey")).toBe(secretKey);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      p_user_id: request.authenticatedUserId,
      p_github_repository_id: "9223372036854775807",
      p_conversation_id: request.conversationId,
      p_max_project_connections: 15,
    });
  });

  it("returns an opaque malformed value for invalid successful JSON", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      client(fetchImplementation).fetchPrivateRuntimeAuthorizationSnapshot(request),
    ).resolves.toBeUndefined();
  });

  it("bounds successful response bodies before parsing", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": "1048577" },
      }),
    );

    await expect(
      client(fetchImplementation).fetchPrivateRuntimeAuthorizationSnapshot(request),
    ).resolves.toBeUndefined();
  });

  it("enforces the byte bound even without a Content-Length header", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      new Response("x".repeat(1_048_577), { status: 200 }),
    );

    await expect(
      client(fetchImplementation).fetchPrivateRuntimeAuthorizationSnapshot(request),
    ).resolves.toBeUndefined();
  });

  it("turns HTTP failures into a safe error without reading the response body", async () => {
    const sensitiveBody = "repository and database details must stay private";
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      new Response(sensitiveBody, { status: 500 }),
    );

    let caught: unknown;
    try {
      await client(fetchImplementation).fetchPrivateRuntimeAuthorizationSnapshot(
        request,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: "Supabase authorization RPC is unavailable",
    });
    expect(String(caught)).not.toContain(sensitiveBody);
  });

  it("classifies malformed 2xx JSON as an invalid snapshot through the repository", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      new Response("not-json", { status: 200 }),
    );
    const repository = new SupabasePrivateRuntimeAuthorizationRepository(
      client(fetchImplementation),
    );

    await expect(
      repository.loadPrivateRuntimeAuthorizationSnapshot(
        {
          authenticatedUserId: request.authenticatedUserId,
          githubRepositoryId: request.githubRepositoryId,
          conversationId: request.conversationId,
        },
        { maximumProjectConnections: 15 },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_SUPABASE_AUTHORIZATION_SNAPSHOT",
      message: "Authorization persistence returned an invalid snapshot",
    });
  });

  it("preserves AbortError so the repository can classify cancellation", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      return Response.json({});
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client(fetchImplementation).fetchPrivateRuntimeAuthorizationSnapshot(
        request,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("sends connector-derived display metadata and rejects canonical paths", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      Response.json({ outcome: "recorded", scopeRequestId: request.conversationId }),
    );
    const rpc = client(fetchImplementation);
    const scopeRequest = {
      scopeRequestId: request.conversationId,
      taskId: "cccccccc-0000-4000-8000-000000000003",
      ownerUserId: request.authenticatedUserId,
      peerUserId: "dddddddd-0000-4000-8000-000000000004",
      requestedHint: null,
      requestedReason: "The known file needs reapproval",
      candidateResourceId: `resource_${"a".repeat(24)}`,
      resourceDisplayLabel: "src/settings.ts",
    };

    await rpc.recordCapabilityScopeRequest(scopeRequest);

    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(
      "https://example-project.supabase.co/rest/v1/rpc/record_capability_scope_request",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      p_candidate_resource_id: scopeRequest.candidateResourceId,
      p_resource_display_label: "src/settings.ts",
    });

    await expect(
      rpc.recordCapabilityScopeRequest({
        ...scopeRequest,
        resourceDisplayLabel: "C:\\Users\\owner\\repo\\src\\settings.ts",
      }),
    ).rejects.toThrow("Supabase capability scope request is invalid");
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("rejects unsafe configuration and malformed RPC identifiers generically", async () => {
    expect(
      () =>
        new SupabaseAuthorizationRpcClient({
          supabaseUrl: "http://example-project.supabase.co",
          secretKey,
        }),
    ).toThrow("Supabase authorization client configuration is invalid");
    expect(
      () =>
        new SupabaseAuthorizationRpcClient({
          supabaseUrl: "https://example-project.supabase.co",
          secretKey: "sb_publishable_" + "a".repeat(32),
        }),
    ).toThrow("Supabase authorization client configuration is invalid");

    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(
      client(fetchImplementation).fetchPrivateRuntimeAuthorizationSnapshot({
        ...request,
        authenticatedUserId: "browser-controlled-user",
      }),
    ).rejects.toThrow("Supabase authorization RPC request is invalid");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
