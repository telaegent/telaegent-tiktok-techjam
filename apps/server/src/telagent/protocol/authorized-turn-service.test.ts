import { describe, expect, it, vi } from "vitest";
import type { AuthorizedPrivateRuntimeTurnPolicy } from "../../authorization/authorized-private-runtime-turn.js";
import {
  PrivateRuntimeAuthorizationError,
  type PrivateRuntimeAuthorizer,
} from "../../authorization/private-runtime-authorization.js";
import type {
  AuthorizePrivateRuntimeInput,
  AuthorizedPrivateRuntime,
} from "../../authorization/types.js";
import {
  InMemoryProviderSessionStore,
  type ProviderSessionRuntime,
} from "../../provider-session-manager.js";
import type {
  MiddlewareRunRequest,
  NormalizedRunResult,
  SessionMode,
} from "../../runtime-contract.js";
import type {
  ConnectorJobRelay,
  ConnectorJobRequest,
} from "../../connectors/connector-turn-executor.js";
import type { ProjectFacts, ProtocolRole } from "./contract.js";
import {
  AuthorizedProtocolTurnService,
  createAuthorizedProtocolTurnRuntime,
} from "./authorized-turn-service.js";
import {
  ProtocolHydrationError,
  type DurableContextLoader,
  type DurableConversationContext,
} from "./runtime-adapter.js";

const AUTHORIZATION: AuthorizePrivateRuntimeInput = {
  authenticatedUserId: "user-justin",
  githubRepositoryId: "123",
  conversationId: "conv-1",
};
const POLICY: AuthorizedPrivateRuntimeTurnPolicy = {
  maxTurns: 3,
  maximumRuntimePromptBytes: 1_048_576,
  maximumPersistedSummaryBytes: 524_288,
};
const FACTS: ProjectFacts = {
  repositoryFullName: "telaegent/backend",
  githubRepositoryId: "123",
  branch: "feat/auth",
  commit: "0123456789abcdef0123456789abcdef01234567",
  ownerName: "Justin",
  collaboratorName: "Phuong",
};

function durableContext(
  role: ProtocolRole = "recipient",
  overrides: Partial<DurableConversationContext> = {},
): DurableConversationContext {
  return {
    role,
    facts: FACTS,
    sharedHistory: [],
    projectFacts: ["repository telaegent/backend"],
    ...(role === "sender"
      ? { ownerInput: "Ask how token rotation works" }
      : { incomingMessage: "How does token rotation work?" }),
    ...overrides,
  };
}

function fakeAuthorizer(revoked = false): PrivateRuntimeAuthorizer {
  return {
    async authorizePrivateRuntime(
      input: Readonly<AuthorizePrivateRuntimeInput>,
    ): Promise<AuthorizedPrivateRuntime> {
      if (revoked) {
        throw new PrivateRuntimeAuthorizationError(
          "PRIVATE_RUNTIME_FORBIDDEN",
          "not_authorized",
        );
      }
      return {
        userId: input.authenticatedUserId,
        githubRepositoryId: input.githubRepositoryId,
        runtimeBindingId: "binding-1",
      };
    },
  };
}

function harness(options: {
  revoked?: boolean;
  initialContext?: DurableConversationContext | null;
  loadError?: boolean;
} = {}) {
  let stored = options.initialContext === undefined
    ? durableContext()
    : options.initialContext;
  const load = vi.fn<DurableContextLoader>(async () => {
    if (options.loadError) throw new Error("database detail must not escape");
    return stored;
  });
  const runs: MiddlewareRunRequest[] = [];
  const runtime: ProviderSessionRuntime = {
    async run(request): Promise<NormalizedRunResult> {
      runs.push(request);
      return {
        provider: request.provider,
        sessionId: "session-" + String(runs.length),
        final: { state: "ready" },
        changedFiles: [],
        exitCode: 0,
        durationMs: 1,
      };
    },
  };
  const authorizer = fakeAuthorizer(options.revoked);
  const { turns: service } = createAuthorizedProtocolTurnRuntime({
    authorizer,
    loadContext: load,
    runtime,
    sessionStore: new InMemoryProviderSessionStore(),
    policy: POLICY,
  });
  return {
    load,
    runs,
    service,
    setContext(context: DurableConversationContext | null) {
      stored = context;
    },
  };
}

async function start(
  service: AuthorizedProtocolTurnService,
  options: { role?: ProtocolRole; sessionMode?: SessionMode } = {},
) {
  const started = await service.start({
    authorization: AUTHORIZATION,
    provider: "claude",
    role: options.role ?? "recipient",
    correlationId: "corr-1",
    ...(options.sessionMode ? { sessionMode: options.sessionMode } : {}),
  });
  return started.completion;
}

describe("AuthorizedProtocolTurnService", () => {
  it("runs sender and recipient turns with authorization-owned infrastructure", async () => {
    for (const role of ["sender", "recipient"] as const) {
      const context = durableContext(role);
      const { runs, service } = harness({ initialContext: context });
      await start(service, { role });

      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        purpose: role === "sender" ? "sender_draft" : "recipient_answer",
        // Cloud-facing requests remain path-free; the local connector resolves
        // its workspace from the opaque binding.
        agentId: "binding-1",
        sandboxMode: "read-only",
        networkMode: "none",
        maxTurns: POLICY.maxTurns,
      });
    }
  });

  it.each([undefined, "fresh", "ephemeral"] as const)(
    "blocks mismatched repository context for session mode %s",
    async (sessionMode) => {
      const mismatch = durableContext("recipient", {
        facts: { ...FACTS, githubRepositoryId: "999" },
      });
      const { runs, service } = harness({ initialContext: mismatch });

      await expect(start(service, { sessionMode })).rejects.toMatchObject({
        code: "DURABLE_CONTEXT_SCOPE_MISMATCH",
        retryable: false,
      });
      expect(runs).toHaveLength(0);
    },
  );

  it("validates context even when an existing provider session could resume", async () => {
    const { runs, service, setContext } = harness();
    await start(service);
    expect(runs).toHaveLength(1);

    setContext(durableContext("recipient", {
      facts: { ...FACTS, githubRepositoryId: "999" },
    }));
    await expect(start(service)).rejects.toMatchObject({
      code: "DURABLE_CONTEXT_SCOPE_MISMATCH",
    });
    expect(runs).toHaveLength(1);
  });

  it.each([
    { name: "missing", initialContext: null, loadError: false },
    { name: "unreachable", initialContext: durableContext(), loadError: true },
  ])("fails closed when durable context is $name", async (testCase) => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runs, service } = harness(testCase);
    try {
      const error = await start(service).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProtocolHydrationError);
      expect(error).toMatchObject({
        code: "DURABLE_CONTEXT_UNAVAILABLE",
        retryable: true,
      });
      expect(String(error)).not.toContain("database detail");
      expect(runs).toHaveLength(0);
      if (testCase.loadError) {
        expect(errorLog).toHaveBeenCalledWith(
          "DURABLE_CONTEXT_LOAD_FAILED",
          "Error",
        );
        expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
          "database detail",
        );
      } else {
        expect(errorLog).not.toHaveBeenCalled();
      }
    } finally {
      errorLog.mockRestore();
    }
  });

  it("blocks a role mismatch before provider execution", async () => {
    const { runs, service } = harness({
      initialContext: durableContext("recipient"),
    });
    await expect(start(service, { role: "sender" })).rejects.toMatchObject({
      code: "DURABLE_CONTEXT_PURPOSE_MISMATCH",
      retryable: false,
    });
    expect(runs).toHaveLength(0);
  });

  it("dispatches the canonical cloud composition to a local connector", async () => {
    const jobs: ConnectorJobRequest[] = [];
    const connector: ConnectorJobRelay = {
      async dispatch(job) {
        jobs.push(job as ConnectorJobRequest);
        return {
          provider: job.provider,
          final: { state: "ready" },
          changedFiles: [],
          exitCode: 0,
          durationMs: 1,
        };
      },
      cancel: async () => false,
    };
    const runtime = createAuthorizedProtocolTurnRuntime({
      authorizer: fakeAuthorizer(),
      loadContext: async () => durableContext(),
      connector,
      policy: POLICY,
    });

    // The cloud build owns no provider session cache; the connector does.
    expect(runtime.sessions).toBeUndefined();
    await (await start(runtime.turns)).completion;

    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.connectorBindingId).toBe("binding-1");
    expect(job.sandboxMode).toBe("read-only");
    expect(job.networkMode).toBe("none");
    // Assert on the job envelope, not the prompt body: Hien's prompt text
    // legitimately uses words like "workspace" when instructing the agent.
    const { runtimePrompt: _prompt, ...envelope } = job;
    expect(JSON.stringify(envelope)).not.toMatch(
      /workspacePath|sessionId|credential/i,
    );
  });

  /**
   * Cancel/No has to reach the machine actually running the turn.
   *
   * Production composes this factory, and it used to build the coordinator with
   * no canceller at all. Every Cancel on a running draft therefore failed
   * closed: the coordinator returned false without asking anyone, and the owner
   * could not stop an agent already reading their repository.
   */
  it("lets the owner cancel a running cloud turn through the connector", async () => {
    const cancelled: string[] = [];
    let release: (() => void) | undefined;
    const connector: ConnectorJobRelay = {
      async dispatch(job) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          provider: job.provider,
          final: { state: "ready" },
          changedFiles: [],
          exitCode: 0,
          durationMs: 1,
        };
      },
      async cancel(connectorBindingId) {
        cancelled.push(connectorBindingId);
        return true;
      },
    };
    const runtime = createAuthorizedProtocolTurnRuntime({
      authorizer: fakeAuthorizer(),
      loadContext: async () => durableContext(),
      connector,
      policy: POLICY,
    });

    const started = await runtime.turns.start({
      authorization: AUTHORIZATION,
      provider: "claude",
      role: "recipient",
      correlationId: "corr-1",
    });
    // The turn only becomes cancellable once it is running, which the executor
    // reports as it hands the job to the relay.
    await expect
      .poll(() =>
        runtime.coordinator.status(started.turnId, {
          userId: AUTHORIZATION.authenticatedUserId,
          githubRepositoryId: AUTHORIZATION.githubRepositoryId,
          conversationId: AUTHORIZATION.conversationId,
        })?.state,
      )
      .toBe("running");

    await expect(
      runtime.coordinator.cancel(started.turnId, {
        userId: AUTHORIZATION.authenticatedUserId,
        githubRepositoryId: AUTHORIZATION.githubRepositoryId,
        conversationId: AUTHORIZATION.conversationId,
      }),
    ).resolves.toBe(true);
    // Addressed by binding, so the cancellation reaches exactly the connector
    // holding that repository and no other.
    expect(cancelled).toEqual(["binding-1"]);

    release?.();
    await started.completion;
  });

  it("threads the opt-in continuity memory profile into cloud-built prompts", async () => {
    const jobs: ConnectorJobRequest[] = [];
    const connector: ConnectorJobRelay = {
      async dispatch(job) {
        jobs.push(job as ConnectorJobRequest);
        return {
          provider: job.provider,
          final: { state: "ready" },
          changedFiles: [],
          exitCode: 0,
          durationMs: 1,
        };
      },
      cancel: async () => false,
    };
    const sharedHistory = Array.from({ length: 12 }, (_, index) => ({
      id: "message-" + String(index),
      author: index % 2 === 0 ? "Phuong" : "Justin",
      origin: "agent" as const,
      text:
        index === 1
          ? "We agreed the compatibility window must remain 4200 milliseconds."
          : "Routine follow-up " + String(index),
      at: "2026-09-01T00:" + String(index).padStart(2, "0") + ":00.000Z",
    }));
    const runtime = createAuthorizedProtocolTurnRuntime({
      authorizer: fakeAuthorizer(),
      loadContext: async () => durableContext("recipient", { sharedHistory }),
      connector,
      memoryProfile: "continuity-v2",
      policy: POLICY,
    });

    await (await start(runtime.turns)).completion;

    expect(jobs[0]?.runtimePrompt).toContain("4200 milliseconds");
  });

  it("authorizes before reading private durable context", async () => {
    const { load, runs, service } = harness({ revoked: true });
    await expect(start(service)).rejects.toBeInstanceOf(
      PrivateRuntimeAuthorizationError,
    );
    expect(load).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
  });
});
