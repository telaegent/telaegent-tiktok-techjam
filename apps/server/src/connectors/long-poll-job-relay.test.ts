import { describe, expect, it, vi } from "vitest";
import { RunCancelledError } from "../errors.js";
import { RuntimeProviderError } from "../runtime-errors.js";
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

describe("LongPollConnectorJobRelay", () => {
  it("routes one path-free job to its authenticated connector and returns a result", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    const onProgress = vi.fn();
    const completion = relay.dispatch(job, onProgress);

    await expect(relay.poll(principal, bindingId, 0)).resolves.toEqual({
      kind: "job",
      job,
    });
    expect(relay.publishProgress(principal, job.jobId, {
      type: "turn_started",
      provider: "claude",
    })).toBe(true);
    expect(onProgress).toHaveBeenCalledWith({
      type: "turn_started",
      provider: "claude",
    });
    expect(relay.complete(principal, job.jobId, {
      provider: "claude",
      final: { message: "ready" },
      changedFiles: [],
      exitCode: 0,
      durationMs: 42,
    })).toBe(true);
    await expect(completion).resolves.toEqual({
      provider: "claude",
      final: { message: "ready" },
      changedFiles: [],
      exitCode: 0,
      durationMs: 42,
    });
  });

  it("never leases a binding to another connector principal", async () => {
    const relay = new LongPollConnectorJobRelay();
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    await expect(
      relay.poll({ ...principal, connectorInstanceId: "connector_instance_0002" }, bindingId, 0),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_RUNTIME_POLICY" });
  });

  it("fails closed before a repository proof registers the binding", async () => {
    const relay = new LongPollConnectorJobRelay();
    await expect(relay.dispatch(job)).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
  });

  it("rejects duplicate work for one user x repository binding", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    const first = relay.dispatch(job);
    await expect(relay.dispatch({ ...job, jobId: "job-2" })).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
    await relay.poll(principal, bindingId, 0);
    relay.complete(principal, job.jobId, {
      provider: "claude",
      final: {},
      changedFiles: [],
      exitCode: 0,
      durationMs: 1,
    });
    await first;
  });

  it("normalizes connector failures without accepting private error text", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    const completion = relay.dispatch(job);
    await relay.poll(principal, bindingId, 0);
    expect(relay.fail(principal, job.jobId, "RUNTIME_AUTHENTICATION_FAILED")).toBe(true);
    await expect(completion).rejects.toEqual(
      expect.objectContaining({
        code: "RUNTIME_AUTHENTICATION_FAILED",
        message: "Local provider authentication is required",
      }),
    );
  });

  it("reports cancellation only after the connector confirms its local process stopped", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    const completion = relay.dispatch(job);
    await relay.poll(principal, bindingId, 0);
    let cancellationSettled = false;
    const cancellation = relay.cancel(bindingId).finally(() => {
      cancellationSettled = true;
    });
    await Promise.resolve();
    expect(cancellationSettled).toBe(false);
    expect(relay.complete(principal, job.jobId, {
      provider: "claude",
      final: {},
      changedFiles: [],
      exitCode: 0,
      durationMs: 1,
    })).toBe(false);
    // An idempotent proof replay must not erase cancellation while the local
    // provider is still stopping.
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    await expect(relay.poll(principal, bindingId, 0)).resolves.toEqual({
      kind: "cancel",
      jobId: job.jobId,
    });
    expect(cancellationSettled).toBe(false);
    expect(relay.acknowledgeCancellation(principal, job.jobId)).toBe(true);
    await expect(cancellation).resolves.toBe(true);
    await expect(completion).rejects.toBeInstanceOf(RunCancelledError);
  });

  it("fails visibly when a leased connector never confirms cancellation", async () => {
    vi.useFakeTimers();
    try {
      const relay = new LongPollConnectorJobRelay({
        jobTimeoutMs: 5_000,
        cancellationTimeoutMs: 1_000,
      });
      relay.registerBinding(principal, bindingId, job.githubRepositoryId);
      const completion = relay.dispatch(job);
      await relay.poll(principal, bindingId, 0);
      const cancellation = relay.cancel(bindingId);
      const cancellationFailure = expect(cancellation).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
      });
      const completionFailure = expect(completion).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
      });

      await vi.advanceTimersByTimeAsync(1_000);

      await cancellationFailure;
      await completionFailure;
      expect(relay.acknowledgeCancellation(principal, job.jobId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out jobs that never return", async () => {
    vi.useFakeTimers();
    try {
      const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 1_000 });
      relay.registerBinding(principal, bindingId, job.githubRepositoryId);
      const completion = relay.dispatch(job);
      const assertion = expect(completion).rejects.toBeInstanceOf(RuntimeProviderError);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not dispatch to stale connector presence", async () => {
    let now = 1_000;
    const relay = new LongPollConnectorJobRelay({
      jobTimeoutMs: 5_000,
      presenceTimeoutMs: 1_000,
      now: () => now,
    });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    now += 1_001;
    await expect(relay.dispatch(job)).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
  });

  it("reports only current owner-scoped presence and keeps an active job online", async () => {
    let now = 1_000;
    const relay = new LongPollConnectorJobRelay({
      jobTimeoutMs: 5_000,
      presenceTimeoutMs: 1_000,
      now: () => now,
    });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    expect(relay.isBindingOnline(principal.authenticatedUserId, bindingId)).toBe(true);
    expect(
      relay.isBindingOnline("10000000-0000-4000-8000-000000000099", bindingId),
    ).toBe(false);

    const completion = relay.dispatch(job);
    now += 1_001;
    expect(relay.isBindingOnline(principal.authenticatedUserId, bindingId)).toBe(true);
    await relay.poll(principal, bindingId, 0);
    relay.complete(principal, job.jobId, {
      provider: "claude",
      final: {},
      changedFiles: [],
      exitCode: 0,
      durationMs: 1,
    });
    await completion;
    now += 1_001;
    expect(relay.isBindingOnline(principal.authenticatedUserId, bindingId)).toBe(false);
  });

  it("reports only live-probed providers for the owning repository", () => {
    let now = 1_000;
    const relay = new LongPollConnectorJobRelay({
      presenceTimeoutMs: 1_000,
      now: () => now,
    });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    expect(relay.availableProviders(principal.authenticatedUserId, job.githubRepositoryId))
      .toEqual([]);

    relay.markBindingReady(principal, bindingId, ["codex"]);
    expect(relay.availableProviders(principal.authenticatedUserId, job.githubRepositoryId))
      .toEqual(["codex"]);
    expect(relay.availableProviders("10000000-0000-4000-8000-000000000099", job.githubRepositoryId))
      .toEqual([]);

    now += 1_001;
    expect(relay.availableProviders(principal.authenticatedUserId, job.githubRepositoryId))
      .toEqual([]);
  });

  it("replaces provider inventory across Codex, both, and Claude-only reconnects", () => {
    const relay = new LongPollConnectorJobRelay();
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    relay.markBindingReady(principal, bindingId, ["codex"]);
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    relay.markProviderProbeSucceeded(principal, bindingId, "claude");
    relay.markBindingReady(principal, bindingId, ["claude", "codex"]);
    expect(relay.availableProviders(principal.authenticatedUserId, job.githubRepositoryId)).toEqual(["claude", "codex"]);
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    relay.markBindingReady(principal, bindingId, ["claude"]);
    expect(relay.availableProviders(principal.authenticatedUserId, job.githubRepositoryId)).toEqual(["claude"]);
    // Periodic proof refresh must preserve the finalized inventory.
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    expect(relay.availableProviders(principal.authenticatedUserId, job.githubRepositoryId)).toEqual(["claude"]);
    expect(relay.availableProviders(principal.authenticatedUserId, "999")).toEqual([]);
  });

  it("clears the previous run's providers when a lock-owning connector starts probing", () => {
    const relay = new LongPollConnectorJobRelay();
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    relay.markBindingReady(principal, bindingId, ["codex"]);
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    expect(relay.availableProviders(principal.authenticatedUserId, job.githubRepositoryId)).toEqual(["codex"]);

    relay.markBindingProbing(principal, bindingId);
    expect(relay.availableProviders(principal.authenticatedUserId, job.githubRepositoryId)).toEqual([]);
    relay.markProviderProbeSucceeded(principal, bindingId, "claude");
    expect(relay.availableProviders(principal.authenticatedUserId, job.githubRepositoryId)).toEqual(["claude"]);
  });

  it("removes proven bindings when the connector credential is rotated or revoked", async () => {
    const relay = new LongPollConnectorJobRelay();
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    await relay.unregisterPrincipal(principal);
    await expect(relay.poll(principal, bindingId, 0)).rejects.toMatchObject({
      code: "UNSUPPORTED_RUNTIME_POLICY",
    });
    await expect(relay.dispatch(job)).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
  });

  it("unregisters only the requested user x repository binding", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    const otherBindingId = "50000000-0000-4000-8000-000000000006";
    const otherRepositoryId = "9223372036854775806";
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    relay.registerBinding(principal, otherBindingId, otherRepositoryId);

    await expect(
      relay.unregisterRepositoryBinding(principal, job.githubRepositoryId),
    ).resolves.toBe(true);
    await expect(relay.dispatch(job)).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
    await expect(relay.poll(principal, otherBindingId, 0)).resolves.toBeNull();
    expect(relay.registeredRepository(principal, otherBindingId)).toBe(
      otherRepositoryId,
    );
  });

  it("browser disconnect removes every installation for only one user and repository", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    const secondInstance = {
      ...principal,
      connectorInstanceId: "connector_instance_0002",
    };
    const otherUser = {
      authenticatedUserId: "10000000-0000-4000-8000-000000000002",
      connectorInstanceId: "connector_instance_0003",
    };
    const secondBinding = "50000000-0000-4000-8000-000000000006";
    const otherUserBinding = "50000000-0000-4000-8000-000000000007";
    const otherRepositoryBinding = "50000000-0000-4000-8000-000000000008";
    const otherRepositoryId = "9223372036854775806";
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    relay.registerBinding(secondInstance, secondBinding, job.githubRepositoryId);
    relay.registerBinding(otherUser, otherUserBinding, job.githubRepositoryId);
    relay.registerBinding(principal, otherRepositoryBinding, otherRepositoryId);

    await expect(relay.unregisterUserRepositoryBindings(
      principal.authenticatedUserId,
      job.githubRepositoryId,
    )).resolves.toBe(true);

    for (const [owner, id] of [[principal, bindingId], [secondInstance, secondBinding]] as const) {
      await expect(relay.poll(owner, id, 0)).rejects.toMatchObject({
        code: "UNSUPPORTED_RUNTIME_POLICY",
      });
    }
    expect(relay.registeredRepository(otherUser, otherUserBinding)).toBe(
      job.githubRepositoryId,
    );
    expect(relay.registeredRepository(principal, otherRepositoryBinding)).toBe(
      otherRepositoryId,
    );
  });

  it("preserves an authenticated cancellation after a leased binding is removed", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    const completion = relay.dispatch(job);
    await relay.poll(principal, bindingId, 0);
    await relay.unregisterRepositoryBinding(principal, job.githubRepositoryId);

    const otherPrincipal = {
      ...principal,
      connectorInstanceId: "connector_instance_0002",
    };
    await expect(relay.poll(otherPrincipal, bindingId, 0)).rejects.toMatchObject({
      code: "UNSUPPORTED_RUNTIME_POLICY",
    });
    await expect(relay.poll(principal, bindingId, 0)).resolves.toEqual({
      kind: "cancel",
      jobId: job.jobId,
    });
    expect(relay.acknowledgeCancellation(principal, job.jobId)).toBe(true);
    await expect(completion).rejects.toBeInstanceOf(RunCancelledError);
    await expect(relay.poll(principal, bindingId, 0)).rejects.toMatchObject({
      code: "UNSUPPORTED_RUNTIME_POLICY",
    });
  });

  it("releases the binding poll slot when a connector abandons its long poll", async () => {
    const relay = new LongPollConnectorJobRelay({ jobTimeoutMs: 5_000 });
    relay.registerBinding(principal, bindingId, job.githubRepositoryId);
    const abandoned = new AbortController();

    const abandonedPoll = relay.poll(principal, bindingId, 20_000, abandoned.signal);
    abandoned.abort();

    // A connector re-polls the instant its job finishes. A waiter left behind by
    // the abandoned poll would reject that poll for the rest of the wait window.
    await expect(relay.poll(principal, bindingId, 1)).resolves.toBeNull();
    await expect(abandonedPoll).resolves.toBeNull();
  });
});
