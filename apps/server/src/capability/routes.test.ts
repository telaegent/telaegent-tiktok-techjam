import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type {
  CapabilityScopeRequestRepository,
  PendingCapabilityScopeRequest,
} from "../authorization/capability-scope-requests.js";
import { CapabilityScopeExpansionService } from "./service.js";

const ownerId = "10000000-0000-4000-8000-000000000001";
const peerId = "10000000-0000-4000-8000-000000000002";
const taskId = "20000000-0000-4000-8000-000000000001";
const conversationId = "30000000-0000-4000-8000-000000000001";
const scopeRequestId = "40000000-0000-4000-8000-000000000001";
const grantId = "50000000-0000-4000-8000-000000000001";
const candidateResourceId = `resource_${"a".repeat(24)}`;
const githubRepositoryId = "1345851084";

const pending: PendingCapabilityScopeRequest = {
  scopeRequestId,
  taskId,
  conversationId,
  githubRepositoryId: githubRepositoryId as PendingCapabilityScopeRequest["githubRepositoryId"],
  peerUserId: peerId,
  requestedHint: "src/settings.ts",
  requestedReason: "the landing page imports it",
  candidateResourceId,
  resourceDisplayLabel: "src/settings.ts",
  operation: "read",
  requestedAt: "2026-08-31T09:40:00.000Z",
  taskExpiresAt: "2026-08-31T10:40:00.000Z",
};

/** Refuses everything unless a test opts one call in. */
function stubRepository(
  overrides: Partial<CapabilityScopeRequestRepository> = {},
): CapabilityScopeRequestRepository {
  return {
    recordScopeRequest: async () => ({ outcome: "task_unavailable" }),
    decideScopeRequest: async () => ({ outcome: "unavailable" }),
    listPendingScopeRequests: async () => [],
    beginFollowUpRound: async () => ({ outcome: "task_unavailable" }),
    ...overrides,
  };
}

async function appWith(
  repository: CapabilityScopeRequestRepository,
  authenticatedUserId: () => Promise<string> = async () => ownerId,
  newId: () => string = () => grantId,
) {
  return createApp(
    loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "legacy-admin-token" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      service: new CapabilityScopeExpansionService({ repository, newId }),
      authenticatedUserId,
    },
  );
}

describe("scope expansion approval routes", () => {
  it("shows a person only the questions addressed to them, in one repository", async () => {
    const listPendingScopeRequests = vi.fn<
      CapabilityScopeRequestRepository["listPendingScopeRequests"]
    >(async () => [pending]);
    const app = await appWith(stubRepository({ listPendingScopeRequests }));

    const response = await app.inject({
      method: "GET",
      url: `/api/capability/scope-requests?githubRepositoryId=${githubRepositoryId}`,
    });

    expect(response.statusCode).toBe(200);
    // An approval queue is per-person and momentary; it must never sit in a
    // shared cache where the next reader inherits someone else's decision.
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.json()).toEqual({ requests: [pending] });
    // The browser cannot choose whose queue it reads. The session decides.
    expect(listPendingScopeRequests).toHaveBeenCalledWith(
      { ownerUserId: ownerId, githubRepositoryId },
      expect.anything(),
    );
    const options = listPendingScopeRequests.mock.calls[0]?.[1];
    expect(options?.signal?.aborted).toBe(false);
    await app.close();
  });

  it("aborts a pending capability call when the response socket closes early", async () => {
    let started!: () => void;
    const callStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let observedAbort!: () => void;
    const abortObserved = new Promise<void>((resolve) => {
      observedAbort = resolve;
    });
    const listPendingScopeRequests = vi.fn<
      CapabilityScopeRequestRepository["listPendingScopeRequests"]
    >(async (_input, options) => {
      started();
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            observedAbort();
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    });
    const app = await appWith(stubRepository({ listPendingScopeRequests }));
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const pendingRequest = httpRequest(
      `${address}/api/capability/scope-requests?githubRepositoryId=${githubRepositoryId}`,
    );
    pendingRequest.on("error", () => undefined);
    pendingRequest.end();

    await callStarted;
    pendingRequest.destroy();
    await abortObserved;

    expect(listPendingScopeRequests).toHaveBeenCalledOnce();
    await app.close();
  });

  it("never puts a path in front of the human", async () => {
    const app = await appWith(stubRepository({ listPendingScopeRequests: async () => [pending] }));

    const response = await app.inject({
      method: "GET",
      url: `/api/capability/scope-requests?githubRepositoryId=${githubRepositoryId}`,
    });

    // The peer's own words are shown, because a human needs them to decide.
    // What is not shown is where the file lives: the queue routes an opaque
    // identifier the owner's connector minted, and the cloud never learns more.
    const body = response.payload;
    expect(body).toContain("src/settings.ts");
    expect(body).toContain(candidateResourceId);
    expect(body).not.toContain("/home/");
    expect(body).not.toContain("canonicalPath");
    await app.close();
  });

  it("requires a repository, because repository ID is the scope boundary", async () => {
    const listPendingScopeRequests = vi.fn<
      CapabilityScopeRequestRepository["listPendingScopeRequests"]
    >(async () => []);
    const app = await appWith(stubRepository({ listPendingScopeRequests }));

    const missing = await app.inject({
      method: "GET",
      url: "/api/capability/scope-requests",
    });
    const notARepository = await app.inject({
      method: "GET",
      url: "/api/capability/scope-requests?githubRepositoryId=0",
    });

    expect(missing.statusCode).toBe(400);
    expect(notARepository.statusCode).toBe(400);
    expect(listPendingScopeRequests).not.toHaveBeenCalled();
    await app.close();
  });

  it("records Allow for this task and reports the authority it created", async () => {
    const decideScopeRequest = vi.fn<
      CapabilityScopeRequestRepository["decideScopeRequest"]
    >(async () => ({ outcome: "approved", grantId, mode: "task" }));
    const app = await appWith(stubRepository({ decideScopeRequest }));

    const response = await app.inject({
      method: "POST",
      url: `/api/capability/scope-requests/${scopeRequestId}/decision`,
      payload: { decision: "task" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: "approved", grantId, mode: "task" });
    // The grant identifier is allocated before the call, so a browser that
    // retries the same press cannot mint a second authority over one file.
    expect(decideScopeRequest).toHaveBeenCalledWith(
      { scopeRequestId, ownerUserId: ownerId, decision: "task", grantId },
      expect.anything(),
    );
    await app.close();
  });

  it("records Deny without creating anything", async () => {
    const app = await appWith(
      stubRepository({ decideScopeRequest: async () => ({ outcome: "denied" }) }),
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/capability/scope-requests/${scopeRequestId}/decision`,
      payload: { decision: "deny" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: "denied" });
    await app.close();
  });

  it("answers a request that is not this person's to decide the same way as one that never existed", async () => {
    const app = await appWith(
      stubRepository({ decideScopeRequest: async () => ({ outcome: "unavailable" }) }),
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/capability/scope-requests/${scopeRequestId}/decision`,
      payload: { decision: "once" },
    });

    // One answer for every way this fails. Whether the request belongs to
    // someone else, was already decided, or never existed is not something a
    // caller may learn by trying.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "That request is not awaiting your decision" });
    await app.close();
  });

  it("refuses a decision that is not one of the three buttons", async () => {
    const decideScopeRequest = vi.fn<
      CapabilityScopeRequestRepository["decideScopeRequest"]
    >(async () => ({ outcome: "approved", grantId, mode: "task" }));
    const app = await appWith(stubRepository({ decideScopeRequest }));

    for (const decision of ["write", "allow", "always", ""]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/capability/scope-requests/${scopeRequestId}/decision`,
        payload: { decision },
      });
      expect(response.statusCode).toBe(400);
    }
    // A widened permission never reached the database to be interpreted.
    expect(decideScopeRequest).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses to decide without a Telaegent browser session", async () => {
    const decideScopeRequest = vi.fn<
      CapabilityScopeRequestRepository["decideScopeRequest"]
    >(async () => ({ outcome: "denied" }));
    const app = await appWith(
      stubRepository({ decideScopeRequest }),
      async () => "",
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/capability/scope-requests/${scopeRequestId}/decision`,
      payload: { decision: "task" },
    });

    // Approval is the one act in the product that must be a person.
    expect(response.statusCode).toBe(401);
    expect(decideScopeRequest).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports an ended collaboration as a conflict rather than an approval", async () => {
    const app = await appWith(
      stubRepository({
        decideScopeRequest: async () => ({ outcome: "task_unavailable" }),
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/capability/scope-requests/${scopeRequestId}/decision`,
      payload: { decision: "task" },
    });

    expect(response.statusCode).toBe(409);
    await app.close();
  });
});

describe("scope expansion service", () => {
  it("queues an ask under a fresh identifier and reports the warm path", async () => {
    const recordScopeRequest = vi.fn<
      CapabilityScopeRequestRepository["recordScopeRequest"]
    >(async () => ({ outcome: "already_granted", grantId }));
    const service = new CapabilityScopeExpansionService({
      repository: stubRepository({ recordScopeRequest }),
      newId: () => scopeRequestId,
    });

    const outcome = await service.queueScopeRequest({
      taskId,
      ownerUserId: ownerId,
      peerUserId: peerId,
      requestedHint: "src/theme.ts",
      requestedReason: "style",
      candidateResourceId,
      resourceDisplayLabel: "src/theme.ts",
    });

    // Authority a human already delegated is reused, not asked for again.
    expect(outcome).toEqual({ outcome: "already_granted", grantId });
    expect(recordScopeRequest).toHaveBeenCalledWith(
      {
        scopeRequestId,
        taskId,
        ownerUserId: ownerId,
        peerUserId: peerId,
        requestedHint: "src/theme.ts",
        requestedReason: "style",
        candidateResourceId,
        resourceDisplayLabel: "src/theme.ts",
      },
      undefined,
    );
  });

  it("spends a follow-up round against the task", async () => {
    const beginFollowUpRound = vi.fn<
      CapabilityScopeRequestRepository["beginFollowUpRound"]
    >(async () => ({ outcome: "exhausted", round: 5 }));
    const service = new CapabilityScopeExpansionService({
      repository: stubRepository({ beginFollowUpRound }),
    });

    // Build plan 8.7: the loop stops on its own after five rounds.
    await expect(
      service.beginFollowUpRound({ taskId, ownerUserId: ownerId, peerUserId: peerId }),
    ).resolves.toEqual({ outcome: "exhausted", round: 5 });
  });
});
