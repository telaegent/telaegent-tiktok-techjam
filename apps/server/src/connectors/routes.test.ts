import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { ConnectorJobRequest } from "./connector-turn-executor.js";
import { LongPollConnectorJobRelay } from "./long-poll-job-relay.js";

const principal = {
  authenticatedUserId: "10000000-0000-4000-8000-000000000001",
  connectorInstanceId: "connector_instance_0001",
};
const bindingId = "50000000-0000-4000-8000-000000000005";
const job: ConnectorJobRequest = {
  jobId: "60000000-0000-4000-8000-000000000006",
  connectorBindingId: bindingId,
  userId: principal.authenticatedUserId,
  githubRepositoryId: "9223372036854775807",
  conversationId: "70000000-0000-4000-8000-000000000007",
  provider: "claude",
  purpose: "sender_draft",
  runtimePrompt: "Prepare a private draft",
  persistedSummary: "Approved history",
  sessionMode: "continue",
  sandboxMode: "read-only",
  networkMode: "none",
  outputSchemaName: "sender-turn.schema.json",
  correlationId: "draft-1",
  maxTurns: 2,
};

describe("connector long-poll HTTP transport", () => {
  it("authenticates every connector request and completes a dispatched job", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    const resolveConnectorPrincipal = vi.fn(async () => principal);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "legacy-browser-token" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { relay, resolveConnectorPrincipal },
    );
    const completion = relay.dispatch(job);

    const delivery = await app.inject({
      method: "GET",
      url: `/api/connectors/jobs/next?connectorBindingId=${bindingId}&waitMs=0`,
    });
    expect(delivery.statusCode).toBe(200);
    expect(delivery.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(delivery.headers.pragma).toBe("no-cache");
    expect(delivery.json()).toEqual({ kind: "job", job });

    const result = await app.inject({
      method: "POST",
      url: `/api/connectors/jobs/${job.jobId}/result`,
      payload: {
        provider: "claude",
        final: { sendCandidate: "Ready" },
        changedFiles: [],
        exitCode: 0,
        durationMs: 12,
      },
    });
    expect(result.statusCode).toBe(204);
    await expect(completion).resolves.toMatchObject({
      provider: "claude",
      final: { sendCandidate: "Ready" },
    });
    expect(resolveConnectorPrincipal).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("rejects unregistered bindings after connector authentication", async () => {
    const relay = new LongPollConnectorJobRelay();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { relay, resolveConnectorPrincipal: async () => principal },
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/connectors/jobs/next?connectorBindingId=${bindingId}&waitMs=0`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "UNSUPPORTED_RUNTIME_POLICY" });
    await app.close();
  });

  it("rejects path-bearing changed-file results at the HTTP boundary", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { relay, resolveConnectorPrincipal: async () => principal },
    );
    const completion = relay.dispatch(job);
    await app.inject({
      method: "GET",
      url: `/api/connectors/jobs/next?connectorBindingId=${bindingId}&waitMs=0`,
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/connectors/jobs/${job.jobId}/result`,
      payload: {
        provider: "claude",
        final: {},
        changedFiles: ["C:\\private\\secret.txt"],
        exitCode: 0,
        durationMs: 1,
      },
    });
    expect(response.statusCode).toBe(400);
    await relay.cancel(bindingId);
    await expect(completion).rejects.toBeDefined();
    await app.close();
  });

  it("rejects raw provider text at the cloud progress boundary", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { relay, resolveConnectorPrincipal: async () => principal },
    );
    const completion = relay.dispatch(job);
    await app.inject({
      method: "GET",
      url: `/api/connectors/jobs/next?connectorBindingId=${bindingId}&waitMs=0`,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/connectors/jobs/${job.jobId}/progress`,
      payload: {
        type: "text_delta",
        provider: "claude",
        text: "raw private provider output C:\\Users\\owner\\repo",
      },
    });

    expect(response.statusCode).toBe(400);
    await relay.cancel(bindingId);
    await expect(completion).rejects.toBeDefined();
    await app.close();
  });

  it("proves one fixed Claude job through the same outbound relay", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { relay, resolveConnectorPrincipal: async () => principal },
    );

    const probeRequest = app.inject({
      method: "POST",
      url: `/api/connectors/bindings/${bindingId}/probe`,
      payload: { provider: "codex" },
    });
    const delivery = await app.inject({
      method: "GET",
      url: `/api/connectors/jobs/next?connectorBindingId=${bindingId}&waitMs=1000`,
    });
    const leased = delivery.json();
    expect(leased.kind).toBe("job");
    expect(leased.job).toMatchObject({
      connectorBindingId: bindingId,
      githubRepositoryId: job.githubRepositoryId,
      provider: "codex",
      sandboxMode: "read-only",
      networkMode: "none",
      purpose: "sender_draft",
      // Never "continue": a resumed session that no longer exists locally makes
      // the provider CLI exit 1 and the readiness check report a healthy
      // provider as unavailable.
      sessionMode: "fresh",
      outputSchemaName: "sender-turn.schema.json",
      maxTurns: 2,
    });
    const result = await app.inject({
      method: "POST",
      url: `/api/connectors/jobs/${leased.job.jobId}/result`,
      payload: {
        provider: "codex",
        final: {
          state: "ready",
          assistantMessage: "The private readiness draft is prepared.",
          sendCandidate: "TELAEGENT IS CONNECTED",
          riskFlags: [],
          referencedPaths: [],
        },
        changedFiles: [],
        exitCode: 0,
        durationMs: 25,
      },
    });
    expect(result.statusCode).toBe(204);
    const probe = await probeRequest;
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toEqual({ connected: true, provider: "codex", durationMs: 25 });
    await app.close();
  });

  it("treats a provider that declines the probe draft as connected", async () => {
    // Captured from Claude Code 2.1.x against the real sender-turn schema. The
    // round trip succeeded and the model still refused to assert a connection
    // it could not observe. Readiness is a property of the pipeline, so a
    // refusal that travelled the whole pipeline is proof the pipeline works.
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { relay, resolveConnectorPrincipal: async () => principal },
    );

    const probeRequest = app.inject({
      method: "POST",
      url: `/api/connectors/bindings/${bindingId}/probe`,
      payload: { provider: "claude" },
    });
    const delivery = await app.inject({
      method: "GET",
      url: `/api/connectors/jobs/next?connectorBindingId=${bindingId}&waitMs=1000`,
    });
    const result = await app.inject({
      method: "POST",
      url: `/api/connectors/jobs/${delivery.json().job.jobId}/result`,
      payload: {
        provider: "claude",
        final: {
          state: "blocked",
          assistantMessage:
            "I'm not going to prepare that message as a ready-to-send confirmation.",
          sendCandidate: null,
          riskFlags: [],
          referencedPaths: [],
        },
        changedFiles: [],
        exitCode: 0,
        durationMs: 31,
      },
    });
    expect(result.statusCode).toBe(204);
    const probe = await probeRequest;
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toEqual({
      connected: true,
      provider: "claude",
      durationMs: 31,
    });
    await app.close();
  });

  it("still rejects a probe result that is not a sender turn", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { relay, resolveConnectorPrincipal: async () => principal },
    );

    const probeRequest = app.inject({
      method: "POST",
      url: `/api/connectors/bindings/${bindingId}/probe`,
      payload: { provider: "claude" },
    });
    const delivery = await app.inject({
      method: "GET",
      url: `/api/connectors/jobs/next?connectorBindingId=${bindingId}&waitMs=1000`,
    });
    const result = await app.inject({
      method: "POST",
      url: `/api/connectors/jobs/${delivery.json().job.jobId}/result`,
      payload: {
        provider: "claude",
        final: { state: "ready" },
        changedFiles: [],
        exitCode: 0,
        durationMs: 12,
      },
    });
    expect(result.statusCode).toBe(204);
    expect((await probeRequest).statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });

  it("frees the binding poll slot when a connector disconnects mid-poll", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { relay, resolveConnectorPrincipal: async () => principal },
    );
    // A real socket is the point: only an actual client disconnect exercises the
    // route's abandonment handling, which app.inject cannot reproduce.
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const registered = new Promise<void>((resolve) => {
      const poll = relay.poll.bind(relay);
      vi.spyOn(relay, "poll").mockImplementation((...args) => {
        const delivery = poll(...args);
        resolve();
        return delivery;
      });
    });

    const abandoned = new AbortController();
    const disconnected = fetch(
      `http://127.0.0.1:${port}/api/connectors/jobs/next`
        + `?connectorBindingId=${bindingId}&waitMs=20000`,
      { signal: abandoned.signal },
    ).catch(() => undefined);
    await registered;
    abandoned.abort();
    await disconnected;

    try {
      await vi.waitFor(async () => {
        await expect(relay.poll(principal, bindingId, 1)).resolves.toBeNull();
      });
    } finally {
      await app.close();
    }
  });
});
