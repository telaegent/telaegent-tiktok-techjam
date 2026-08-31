import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("project conversation API", () => {
  it("opens the selected peer conversation under the selected project", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
        JSON.stringify({
          conversation: {
            conversationId: "40000000-0000-4000-8000-000000000001",
            projectId: "20000000-0000-4000-8000-000000000001",
            githubRepositoryId: "123456789",
            status: "active",
            participantUserIds: [
              "10000000-0000-4000-8000-000000000001",
              "10000000-0000-4000-8000-000000000002",
            ],
            created: false,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.createProjectConversation(
      "20000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "/api/projects/20000000-0000-4000-8000-000000000001/conversations",
    );
    expect(options).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({
        peerUserId: "10000000-0000-4000-8000-000000000002",
      }),
    });
  });

  it("lists pending scope requests under the stable repository boundary", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
        JSON.stringify({ requests: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.capabilityScopeRequests("123456789");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/capability/scope-requests?githubRepositoryId=123456789");
    expect(options).toMatchObject({ credentials: "same-origin" });
  });

  it.each(["deny", "once", "task"] as const)(
    "posts the %s scope decision without widening it in the client",
    async (decision) => {
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
          JSON.stringify(decision === "deny"
            ? { outcome: "denied" }
            : { outcome: "approved", grantId: "grant-id", mode: decision }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      await api.decideCapabilityScopeRequest("scope/request", decision);

      const [url, options] = fetchMock.mock.calls[0]!;
      expect(url).toBe("/api/capability/scope-requests/scope%2Frequest/decision");
      expect(options).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ decision }),
      });
    },
  );
});
