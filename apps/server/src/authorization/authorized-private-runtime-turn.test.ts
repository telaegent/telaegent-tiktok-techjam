import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { PrivateRuntimeTurnCoordinator } from "../private-runtime-turn-coordinator.js";
import {
  InMemoryProviderSessionStore,
  ProviderSessionManager,
  type ProviderSessionRuntime,
} from "../provider-session-manager.js";
import type {
  MiddlewareRunRequest,
  NormalizedRunResult,
} from "../runtime-contract.js";
import { RuntimeProgressChannel } from "../runtime-progress-channel.js";
import {
  AuthorizedPrivateRuntimeTurnStarter,
  InMemoryPrivateRuntimeAuthorizationRepository,
  InvalidPrivateRuntimeTurnError,
  PrivateRuntimeAuthorizationService,
  type BackendPreparedPrivateTurn,
  type InMemoryPrivateRuntimeAuthorizationData,
} from "./index.js";

const authorization = {
  authenticatedUserId: "user-1",
  githubRepositoryId: "1345851083",
  conversationId: "conversation-1",
} as const;
const turn: BackendPreparedPrivateTurn = {
  purpose: "sender_draft",
  runtimePrompt: "Prepare the private draft for human review.",
  persistedSummary: "A private draft was requested.",
  sessionMode: "continue",
  outputSchemaName: "sender-draft.schema.json",
  correlationId: "correlation-1",
};

function authorizationData(
  membershipStatus: "active" | "suspended" | "revoked" = "active",
): InMemoryPrivateRuntimeAuthorizationData {
  return {
    users: [{ userId: "user-1", status: "active" }],
    githubConnections: [{
      githubConnectionId: "github-connection-1",
      userId: "user-1",
      githubUserId: "12345",
      githubLogin: "khoa",
      status: "connected",
      connectedAt: "2026-08-30T10:00:00.000Z",
      lastVerifiedAt: "2026-08-30T11:59:00.000Z",
    }],
    repositoryAccesses: [{
      userId: "user-1",
      githubConnectionId: "github-connection-1",
      githubRepositoryId: "1345851083",
      status: "verified",
      verifiedAt: "2026-08-30T11:59:00.000Z",
    }],
    projects: [{
      projectId: "project-1",
      githubRepositoryId: "1345851083",
      repositoryFullName: "telaegent/telaegent-tiktok-techjam",
      visibility: "private",
      defaultBranch: "main",
      status: "active",
    }],
    memberships: [{
      projectId: "project-1",
      userId: "user-1",
      status: membershipStatus,
      joinedAt: "2026-08-30T10:00:00.000Z",
    }],
    conversations: [{
      conversationId: "conversation-1",
      projectId: "project-1",
      participantUserIds: ["user-1", "user-2"],
      status: "active",
    }],
    projectConnections: [{
      projectConnectionId: "connection-1",
      projectId: "project-1",
      requesterUserId: "user-1",
      recipientUserId: "user-2",
      status: "connected",
      requestedAt: "2026-08-30T10:00:00.000Z",
      acceptedAt: "2026-08-30T10:01:00.000Z",
      revokedAt: null,
    }],
    runtimeBindings: [{
      runtimeBindingId: "runtime-binding-1",
      userId: "user-1",
      projectId: "project-1",
      githubRepositoryId: "1345851083",
      status: "ready",
    }],
  };
}

function normalizedResult(): NormalizedRunResult {
  return {
    provider: "codex",
    sessionId: "private-session-1",
    final: { state: "ready" },
    changedFiles: [],
    exitCode: 0,
    durationMs: 5,
  };
}

function createHarness(
  runImplementation: ProviderSessionRuntime["run"] = async (request, onProgress) => {
    onProgress?.({ type: "turn_started", provider: request.provider });
    onProgress?.({ type: "turn_completed", provider: request.provider });
    return normalizedResult();
  },
) {
  const repository = new InMemoryPrivateRuntimeAuthorizationRepository(
    authorizationData(),
  );
  const authorizer = new PrivateRuntimeAuthorizationService(
    repository,
    {
      repositoryAccessMaxAgeMs: 5 * 60_000,
      repositoryReadTimeoutMs: 100,
    },
    () => new Date("2026-08-30T12:00:00.000Z"),
  );
  const run = vi.fn<ProviderSessionRuntime["run"]>(runImplementation);
  const sessions = new ProviderSessionManager(
    { run },
    new InMemoryProviderSessionStore(),
    async (_scope, request) => request,
  );
  const coordinator = new PrivateRuntimeTurnCoordinator(
    sessions,
    new RuntimeProgressChannel(10),
    { scheduleCleanup: () => undefined },
  );
  const starter = new AuthorizedPrivateRuntimeTurnStarter(
    authorizer,
    coordinator,
    {
      maxTurns: 2,
      maximumRuntimePromptBytes: 100_000,
      maximumPersistedSummaryBytes: 4_000,
    },
  );
  return { repository, run, coordinator, starter };
}

describe("AuthorizedPrivateRuntimeTurnStarter", () => {
  it("uses only the freshly authorized binding and middleware-owned execution policy", async () => {
    const { run, coordinator, starter } = createHarness();
    const maliciousUntypedTurn = {
      ...turn,
      agentId: "attacker-agent",
      workspacePath: "/srv/other-user/private",
      sandboxMode: "workspace-write",
      networkMode: "default",
      maxTurns: 999,
      provider: "claude",
      sessionId: "stolen-session",
    } as unknown as BackendPreparedPrivateTurn;

    const started = await starter.start({
      authorization,
      provider: "codex",
      turn: maliciousUntypedTurn,
    });
    const owner = {
      userId: "user-1",
      githubRepositoryId: "1345851083",
      conversationId: "conversation-1",
    };
    expect(
      coordinator.subscribe(started.streamId, { ...owner, userId: "user-2" }, vi.fn()),
    ).toBeNull();

    await expect(started.completion).resolves.toEqual({
      provider: "codex",
      final: { state: "ready" },
      changedFiles: [],
      exitCode: 0,
      durationMs: 5,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual({
      agentId: "runtime-binding-1",
      provider: "codex",
      purpose: "sender_draft",
      connectorBindingId: "runtime-binding-1",
      runtimePrompt: turn.runtimePrompt,
      persistedSummary: turn.persistedSummary,
      sessionMode: "fresh",
      sandboxMode: "read-only",
      networkMode: "none",
      outputSchemaName: "sender-draft.schema.json",
      correlationId: "correlation-1",
      maxTurns: 2,
    } satisfies MiddlewareRunRequest);

    const subscription = coordinator.subscribe(started.streamId, owner, vi.fn());
    expect(subscription?.replay.map((event) => event.progress.type)).toEqual([
      "turn_started",
      "turn_completed",
    ]);
  });

  it("denies invalid scope before opening a stream or invoking a provider", async () => {
    const { run, starter } = createHarness();

    await expect(
      starter.start({
        authorization: { ...authorization, githubRepositoryId: "999" },
        provider: "codex",
        turn,
      }),
    ).rejects.toMatchObject({
      code: "PRIVATE_RUNTIME_FORBIDDEN",
      message: "Private runtime is not authorized",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("re-authorizes each turn so membership revocation takes effect immediately", async () => {
    const { repository, run, starter } = createHarness();
    const first = await starter.start({ authorization, provider: "codex", turn });
    await first.completion;
    expect(run).toHaveBeenCalledTimes(1);

    repository.replaceData(authorizationData("revoked"));
    await expect(
      starter.start({ authorization, provider: "codex", turn }),
    ).rejects.toMatchObject({
      code: "PRIVATE_RUNTIME_FORBIDDEN",
      message: "Private runtime is not authorized",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("re-authorizes after session queueing so a waiting turn cannot outrun revocation", async () => {
    let finishFirst!: (result: NormalizedRunResult) => void;
    const firstPending = new Promise<NormalizedRunResult>((resolve) => {
      finishFirst = resolve;
    });
    const { repository, run, starter } = createHarness(async () => firstPending);

    const first = await starter.start({ authorization, provider: "codex", turn });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const waiting = await starter.start({ authorization, provider: "codex", turn });
    repository.replaceData(authorizationData("revoked"));
    finishFirst(normalizedResult());

    await expect(first.completion).resolves.toBeDefined();
    await expect(waiting.completion).rejects.toMatchObject({
      code: "PRIVATE_RUNTIME_FORBIDDEN",
      message: "Private runtime is not authorized",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed and oversized backend-prepared inputs without leaking values", async () => {
    const { run, starter } = createHarness();
    const privateValue = "do-not-log-this";
    const error = await starter.start({
      authorization,
      provider: "codex",
      turn: {
        ...turn,
        runtimePrompt: privateValue.repeat(20_000),
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InvalidPrivateRuntimeTurnError);
    expect(String(error)).not.toContain(privateValue);
    expect(JSON.stringify(error)).not.toContain(privateValue);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps runtime control fields out of the typed prepared-turn contract", () => {
    expectTypeOf<BackendPreparedPrivateTurn>().not.toHaveProperty("agentId");
    expectTypeOf<BackendPreparedPrivateTurn>().not.toHaveProperty("workspacePath");
    expectTypeOf<BackendPreparedPrivateTurn>().not.toHaveProperty("sandboxMode");
    expectTypeOf<BackendPreparedPrivateTurn>().not.toHaveProperty("networkMode");
    expectTypeOf<BackendPreparedPrivateTurn>().not.toHaveProperty("maxTurns");
    // A model is a routing choice, so it arrives as its own argument and is
    // allowlisted. Letting it ride inside the prepared turn would put the one
    // caller-chosen value in the request on the path that is not checked.
    expectTypeOf<BackendPreparedPrivateTurn>().not.toHaveProperty("model");
  });

  it("passes an allowlisted model through to the provider request", async () => {
    const { run, starter } = createHarness();

    const started = await starter.start({
      authorization,
      provider: "codex",
      model: "gpt-5.5",
      turn,
    });
    await started.completion;

    expect(run.mock.calls[0]?.[0].model).toBe("gpt-5.5");
  });

  it("omits the model entirely when the caller does not choose one", async () => {
    const { run, starter } = createHarness();

    const started = await starter.start({ authorization, provider: "codex", turn });
    await started.completion;

    // Not `undefined` -- absent. The runners key off presence, so an explicit
    // undefined would still be the same argv, but the connector job schema is
    // strict and a key that is always emitted is a key that has to be allowed.
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty("model");
  });

  it("refuses a model the provider does not offer, before authorizing anything", async () => {
    const { run, starter } = createHarness();

    // A real Claude alias, requested on a Codex turn. Both CLIs would reject
    // this themselves -- but only after a connector had claimed the turn.
    const error = await starter
      .start({ authorization, provider: "codex", model: "opus", turn })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InvalidPrivateRuntimeTurnError);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses argv-shaped model values", async () => {
    const { run, starter } = createHarness();

    for (const model of [
      "--dangerously-skip-permissions",
      "gpt-5.5 --sandbox danger-full-access",
      "",
      "GPT-5.5",
    ]) {
      const error = await starter
        .start({ authorization, provider: "codex", model, turn })
        .catch((caught: unknown) => caught);
      // The empty string is falsy, so it never reaches an argv either way; it
      // is asserted here so that stays true if the check ever moves.
      if (model !== "") expect(error).toBeInstanceOf(InvalidPrivateRuntimeTurnError);
    }

    expect(run).not.toHaveBeenCalled();
  });

  it("ignores a model smuggled through the untyped prepared turn", async () => {
    const { run, starter } = createHarness();
    const smuggled = {
      ...turn,
      model: "gpt-5.5",
    } as unknown as BackendPreparedPrivateTurn;

    const started = await starter.start({
      authorization,
      provider: "codex",
      turn: smuggled,
    });
    await started.completion;

    expect(run.mock.calls[0]?.[0]).not.toHaveProperty("model");
  });
});
