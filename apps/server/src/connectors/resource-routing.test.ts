import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { RuntimeProviderError } from "../runtime-errors.js";
import type { ConnectorJobRequest } from "./connector-turn-executor.js";
import { LongPollConnectorJobRelay } from "./long-poll-job-relay.js";
import type {
  ResourceExchangeRequest,
  ResourceExchangeResponse,
} from "./resource-exchange.js";

const principal = {
  authenticatedUserId: "10000000-0000-4000-8000-000000000001",
  connectorInstanceId: "connector_instance_0001",
};
const otherPrincipal = {
  authenticatedUserId: "10000000-0000-4000-8000-00000000000f",
  connectorInstanceId: "connector_instance_000f",
};
const bindingId = "50000000-0000-4000-8000-000000000005";
const githubRepositoryId = "9223372036854775807";
const resourceId = `resource_${"a".repeat(24)}`;

const job: ConnectorJobRequest = {
  jobId: "60000000-0000-4000-8000-000000000006",
  connectorBindingId: bindingId,
  userId: principal.authenticatedUserId,
  githubRepositoryId,
  conversationId: "70000000-0000-4000-8000-000000000007",
  provider: "claude",
  purpose: "recipient_answer",
  runtimePrompt: "Investigate the recipient repository",
  persistedSummary: "Approved history",
  sessionMode: "continue",
  sandboxMode: "read-only",
  networkMode: "none",
  outputSchemaName: "recipient-turn.schema.json",
  correlationId: "answer-1",
  maxTurns: 2,
};

const exchange: ResourceExchangeRequest = {
  requestId: "exchange-1",
  taskId: "80000000-0000-4000-8000-000000000008",
  connectorBindingId: bindingId,
  peerUserId: "10000000-0000-4000-8000-00000000b002",
  requests: [{ kind: "resource", resourceId, reason: "the page imports it" }],
  grants: [
    {
      grantId: "30000000-0000-4000-8000-000000000001",
      resourceId,
      operation: "read",
      mode: "task",
      expiresAt: null,
    },
  ],
};

const delivered: ResourceExchangeResponse = {
  requestId: exchange.requestId,
  outcomes: [
    {
      status: "delivered",
      resourceId,
      content: "export const page = 1;\n",
      truncated: false,
      audit: {
        resourceId,
        taskId: exchange.taskId,
        recipientUserId: exchange.peerUserId,
        byteLength: 23,
        contentSha256: "a".repeat(64),
        authorizationMode: "task",
        truncated: false,
        deliveredAt: "2026-08-31T12:00:00.000Z",
      },
    },
  ],
};

function relayWithBinding(): LongPollConnectorJobRelay {
  const relay = new LongPollConnectorJobRelay({
    jobTimeoutMs: 5_000,
    resourceTimeoutMs: 5_000,
  });
  relay.registerBinding(principal, bindingId, githubRepositoryId);
  return relay;
}

describe("routing a resource batch to the owning connector", () => {
  it("delivers the batch and returns the connector's answer to the waiting caller", async () => {
    const relay = relayWithBinding();
    const answer = relay.exchangeResources(exchange);

    await expect(relay.poll(principal, bindingId, 0)).resolves.toEqual({
      kind: "resource_request",
      request: exchange,
    });
    expect(
      relay.completeResourceExchange(principal, exchange.requestId, delivered),
    ).toBe(true);
    await expect(answer).resolves.toEqual(delivered);
  });

  it("serves a resource batch before a job that is already queued", async () => {
    const relay = relayWithBinding();
    const completion = relay.dispatch(job);
    const answer = relay.exchangeResources(exchange);

    // A batch answers in milliseconds without launching a provider. Making it
    // wait behind a turn would strand the peer that asked for the file.
    await expect(relay.poll(principal, bindingId, 0)).resolves.toMatchObject({
      kind: "resource_request",
    });
    relay.completeResourceExchange(principal, exchange.requestId, delivered);
    await expect(answer).resolves.toEqual(delivered);

    await expect(relay.poll(principal, bindingId, 0)).resolves.toEqual({
      kind: "job",
      job,
    });
    relay.complete(principal, job.jobId, {
      provider: "claude",
      final: { sendCandidate: "Ready" },
      changedFiles: [],
      exitCode: 0,
      durationMs: 4,
    });
    await expect(completion).resolves.toMatchObject({ exitCode: 0 });
  });

  it("refuses an answer whose outcomes do not line up with the requests", async () => {
    const relay = relayWithBinding();
    const answer = relay.exchangeResources({
      ...exchange,
      requests: [
        { kind: "resource", resourceId, reason: "first" },
        { kind: "hint", hint: "src/settings.ts", reason: "second" },
      ],
    });
    await relay.poll(principal, bindingId, 0);

    // Outcomes are positional. One answer for two requests would silently move
    // one file's bytes onto the other file's question.
    expect(
      relay.completeResourceExchange(principal, exchange.requestId, delivered),
    ).toBe(false);

    const settled = vi.fn();
    void answer.then(settled, settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    expect(
      relay.completeResourceExchange(principal, exchange.requestId, {
        requestId: exchange.requestId,
        outcomes: [delivered.outcomes[0]!, { status: "refused" }],
      }),
    ).toBe(true);
    await expect(answer).resolves.toMatchObject({
      outcomes: [{ status: "delivered" }, { status: "refused" }],
    });
  });

  it("refuses an answer from a connector that does not own the binding", async () => {
    const relay = relayWithBinding();
    const answer = relay.exchangeResources(exchange);
    await relay.poll(principal, bindingId, 0);

    expect(
      relay.completeResourceExchange(otherPrincipal, exchange.requestId, delivered),
    ).toBe(false);
    relay.completeResourceExchange(principal, exchange.requestId, delivered);
    await expect(answer).resolves.toEqual(delivered);
  });

  it("fails an in-flight batch closed when the binding goes away", async () => {
    const relay = relayWithBinding();
    const answer = relay.exchangeResources(exchange);
    await relay.unregisterRepositoryBinding(principal, githubRepositoryId);

    await expect(answer).rejects.toBeInstanceOf(RuntimeProviderError);
    await expect(answer).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("refuses to route to a connector that is not attached", async () => {
    const relay = new LongPollConnectorJobRelay({ resourceTimeoutMs: 5_000 });
    await expect(relay.exchangeResources(exchange)).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
  });
});

describe("connector resource HTTP transport", () => {
  async function appWith(relay: LongPollConnectorJobRelay) {
    return await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "legacy-browser-token" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { relay, resolveConnectorPrincipal: vi.fn(async () => principal) },
    );
  }

  it("carries approved content back without ever caching it", async () => {
    const relay = relayWithBinding();
    const app = await appWith(relay);
    const answer = relay.exchangeResources(exchange);

    const delivery = await app.inject({
      method: "GET",
      url: `/api/connectors/jobs/next?connectorBindingId=${bindingId}&waitMs=0`,
    });
    expect(delivery.json()).toEqual({ kind: "resource_request", request: exchange });

    const posted = await app.inject({
      method: "POST",
      url: `/api/connectors/jobs/${exchange.requestId}/resources`,
      payload: delivered,
    });
    expect(posted.statusCode).toBe(204);
    // Approved bytes transit the relay; they must not be retained anywhere on
    // the way through, including by an intermediary cache.
    expect(posted.headers["cache-control"]).toBe("no-store, max-age=0");
    await expect(answer).resolves.toEqual(delivered);
    await app.close();
  });

  it("rejects an answer to a batch nobody is waiting for", async () => {
    const app = await appWith(relayWithBinding());
    const posted = await app.inject({
      method: "POST",
      url: `/api/connectors/jobs/${exchange.requestId}/resources`,
      payload: delivered,
    });
    expect(posted.statusCode).toBe(409);
    await app.close();
  });

  it("rejects a refusal that tries to smuggle a reason back to the peer", async () => {
    const app = await appWith(relayWithBinding());
    const posted = await app.inject({
      method: "POST",
      url: `/api/connectors/jobs/${exchange.requestId}/resources`,
      payload: {
        requestId: exchange.requestId,
        outcomes: [{ status: "refused", code: "SECRET_PATH" }],
      },
    });
    // Why a read was refused stays on the owner's machine. A peer that could
    // read the code would learn which files exist and which are secret.
    expect(posted.statusCode).toBe(400);
    await app.close();
  });

  it("carries a mintable candidate back so a human can be asked about a real file", async () => {
    const relay = relayWithBinding();
    const app = await appWith(relay);
    const answer = relay.exchangeResources(exchange);
    await app.inject({
      method: "GET",
      url: `/api/connectors/jobs/next?connectorBindingId=${bindingId}&waitMs=0`,
    });

    const posted = await app.inject({
      method: "POST",
      url: `/api/connectors/jobs/${exchange.requestId}/resources`,
      payload: {
        requestId: exchange.requestId,
        outcomes: [
          {
            status: "pending_approval",
            request: { kind: "hint", hint: "src/theme.ts", reason: "the page imports it" },
            candidate: {
              resourceId: `resource_${"b".repeat(24)}`,
              resourceDisplayLabel: "src/settings.ts",
            },
          },
        ],
      },
    });
    expect(posted.statusCode).toBe(204);
    await expect(answer).resolves.toMatchObject({
      outcomes: [
        {
          candidate: {
            resourceId: `resource_${"b".repeat(24)}`,
            resourceDisplayLabel: "src/settings.ts",
          },
        },
      ],
    });
    await app.close();
  });

  it("rejects a candidate that is a path rather than a minted identifier", async () => {
    const relay = relayWithBinding();
    const app = await appWith(relay);
    void relay.exchangeResources(exchange).catch(() => undefined);
    await app.inject({
      method: "GET",
      url: `/api/connectors/jobs/next?connectorBindingId=${bindingId}&waitMs=0`,
    });

    const posted = await app.inject({
      method: "POST",
      url: `/api/connectors/jobs/${exchange.requestId}/resources`,
      payload: {
        requestId: exchange.requestId,
        outcomes: [
          {
            status: "pending_approval",
            request: { kind: "hint", hint: "src/theme.ts", reason: "config" },
            candidate: {
              resourceId: "/home/owner/.env",
              resourceDisplayLabel: "src/settings.ts",
            },
          },
        ],
      },
    });
    // The cloud is about to attach a human's approval to this identifier. It
    // must be something a registry minted, never text that looks like a file.
    expect(posted.statusCode).toBe(400);
    await relay.unregisterRepositoryBinding(principal, githubRepositoryId);
    await app.close();
  });

  it("accepts a job result that asks a peer for resources", async () => {
    const relay = relayWithBinding();
    const app = await appWith(relay);
    const completion = relay.dispatch(job);
    await app.inject({
      method: "GET",
      url: `/api/connectors/jobs/next?connectorBindingId=${bindingId}&waitMs=0`,
    });

    const posted = await app.inject({
      method: "POST",
      url: `/api/connectors/jobs/${job.jobId}/result`,
      payload: {
        provider: "claude",
        final: { sendCandidate: "I need one more file" },
        changedFiles: [],
        exitCode: 0,
        durationMs: 9,
        resourceRequests: [
          { kind: "hint", hint: "src/theme.ts", reason: "the page imports it" },
        ],
      },
    });
    expect(posted.statusCode).toBe(204);
    await expect(completion).resolves.toMatchObject({
      resourceRequests: [{ kind: "hint", hint: "src/theme.ts" }],
    });
    await app.close();
  });

  it("rejects a result that names a canonical path as a resource", async () => {
    const relay = relayWithBinding();
    const app = await appWith(relay);
    const completion = relay.dispatch(job);
    await app.inject({
      method: "GET",
      url: `/api/connectors/jobs/next?connectorBindingId=${bindingId}&waitMs=0`,
    });

    const posted = await app.inject({
      method: "POST",
      url: `/api/connectors/jobs/${job.jobId}/result`,
      payload: {
        provider: "claude",
        final: { sendCandidate: "Ready" },
        changedFiles: [],
        exitCode: 0,
        durationMs: 9,
        resourceRequests: [
          { kind: "resource", resourceId: "/home/owner/.env", reason: "config" },
        ],
      },
    });
    // An agent can name an identifier it was handed. It can never name a file.
    expect(posted.statusCode).toBe(400);
    relay.fail(principal, job.jobId, "RUNTIME_FAILED");
    await expect(completion).rejects.toBeInstanceOf(RuntimeProviderError);
    await app.close();
  });
});
