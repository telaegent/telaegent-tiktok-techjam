/**
 * SEAM TEST — the protocol layer through authorization into the runtime.
 *
 * Every other test in this directory checks one layer with the next one faked.
 * That is how the three of us each ended up confident and still incompatible:
 * my builder satisfied a type, Khoa's starter validated a type, and nothing
 * ever put one into the other.
 *
 * This file does. It runs the real chain:
 *
 *   buildPreparedPrivateTurn()                     protocol   (Hien)
 *        ↓
 *   AuthorizedPrivateRuntimeTurnStarter.start()    authorization (Khoa)
 *        ↓
 *   PrivateRuntimeTurnCoordinator                  runtime    (Phuong)
 *        ↓
 *   ProviderSessionManager → recording runtime
 *
 * Only the two genuine edges are faked: the authorizer (which would reach a
 * database) and the provider runtime (which would spend money). Everything
 * between them is the code that ships.
 *
 * What it is really asserting is that the *boundary* holds: that the fields
 * the protocol layer is not allowed to choose are supplied by authorization and
 * cannot be influenced from here, and that a turn cannot reach a provider
 * without being authorized first.
 */

import { describe, expect, it } from "vitest";

import {
  AuthorizedPrivateRuntimeTurnStarter,
  InvalidPrivateRuntimeTurnError,
  type AuthorizedPrivateRuntimeTurnPolicy,
  type BackendPreparedPrivateTurn,
} from "../../authorization/authorized-private-runtime-turn.js";
import {
  PrivateRuntimeAuthorizationError,
  type PrivateRuntimeAuthorizer,
} from "../../authorization/private-runtime-authorization.js";
import type {
  AuthorizePrivateRuntimeInput,
  AuthorizedPrivateRuntime,
} from "../../authorization/types.js";
import { PrivateRuntimeTurnCoordinator } from "../../private-runtime-turn-coordinator.js";
import {
  InMemoryProviderSessionStore,
  ProviderSessionManager,
  type ProviderSessionRuntime,
} from "../../provider-session-manager.js";
import type {
  MiddlewareRunRequest,
  NormalizedRunResult,
} from "../../runtime-contract.js";

import type { ProjectFacts } from "./contract.js";
import {
  buildPreparedPrivateTurn,
  createProtocolHydrator,
  ProtocolHydrationError,
  type DurableConversationContext,
} from "./runtime-adapter.js";

/* ========================================================================== *
 * Fixtures
 * ========================================================================== */

const AUTHORIZATION: AuthorizePrivateRuntimeInput = {
  authenticatedUserId: "user-justin",
  githubRepositoryId: "123",
  conversationId: "conv-1",
};

/** Where the authorized binding says the workspace is. */
const BOUND_WORKSPACE = "/srv/telaegent/runtimes/user-justin/123";
const BINDING_ID = "binding-abc";

const FACTS: ProjectFacts = {
  repositoryFullName: "telaegent/backend",
  githubRepositoryId: "123",
  branch: "feat/auth",
  commit: "0123456789abcdef0123456789abcdef01234567",
  ownerName: "Justin",
  collaboratorName: "Phuong",
};

function durableContext(
  overrides: Partial<DurableConversationContext> = {},
): DurableConversationContext {
  return {
    role: "recipient",
    facts: FACTS,
    sharedHistory: [
      {
        id: "h0",
        author: "Phuong",
        origin: "agent",
        text: "How does refresh token rotation work?",
        at: "2026-08-28T09:00:00.000Z",
      },
    ],
    projectFacts: ["repository telaegent/backend", "branch feat/auth"],
    incomingMessage: "Does that apply to other devices too?",
    ...overrides,
  };
}

const POLICY: AuthorizedPrivateRuntimeTurnPolicy = {
  maxTurns: 3,
  maximumRuntimePromptBytes: 1_048_576,
  maximumPersistedSummaryBytes: 524_288,
};

function fakeAuthorizer(options: { revoked?: boolean } = {}): PrivateRuntimeAuthorizer {
  return {
    async authorizePrivateRuntime(
      input: Readonly<AuthorizePrivateRuntimeInput>,
    ): Promise<AuthorizedPrivateRuntime> {
      if (options.revoked === true) {
        throw new PrivateRuntimeAuthorizationError(
          "PRIVATE_RUNTIME_FORBIDDEN",
          "not_authorized",
        );
      }
      return {
        userId: input.authenticatedUserId,
        githubRepositoryId: input.githubRepositoryId,
        workspacePath: BOUND_WORKSPACE,
        runtimeBindingId: BINDING_ID,
      };
    },
  };
}

function recordingRuntime(): {
  runtime: ProviderSessionRuntime;
  runs: MiddlewareRunRequest[];
} {
  const runs: MiddlewareRunRequest[] = [];
  return {
    runs,
    runtime: {
      async run(request: MiddlewareRunRequest): Promise<NormalizedRunResult> {
        runs.push(request);
        return {
          provider: request.provider,
          sessionId: "session-" + String(runs.length),
          final: { ok: true },
          changedFiles: [],
          exitCode: 0,
          durationMs: 1,
        };
      },
    },
  };
}

function buildChain(
  options: {
    revoked?: boolean;
    /**
     * What the backend's durable store would return for this conversation.
     * It has to agree with the turn being started: the hydrator refuses to
     * render a sender turn from a recipient's context, and the first version of
     * this file learned that the hard way.
     */
    stored?: DurableConversationContext;
  } = {},
) {
  const { runtime, runs } = recordingRuntime();
  const stored = options.stored ?? durableContext();
  const sessions = new ProviderSessionManager(
    runtime,
    new InMemoryProviderSessionStore(),
    createProtocolHydrator({ load: async () => stored }),
  );
  const coordinator = new PrivateRuntimeTurnCoordinator(sessions);
  const starter = new AuthorizedPrivateRuntimeTurnStarter(
    fakeAuthorizer(options),
    coordinator,
    POLICY,
  );
  return { starter, runs };
}

/* ========================================================================== *
 * The seam
 * ========================================================================== */

describe("protocol → authorization → runtime", () => {
  it("a prepared recipient turn reaches the provider, fully assembled", async () => {
    const { starter, runs } = buildChain();

    const turn = buildPreparedPrivateTurn({
      context: durableContext(),
      correlationId: "corr-1",
    });

    const started = await starter.start({
      authorization: AUTHORIZATION,
      provider: "claude",
      turn,
    });
    await started.completion;

    expect(runs).toHaveLength(1);
    const request = runs[0];

    // Content came from the protocol layer.
    expect(request?.purpose).toBe("recipient_answer");
    expect(request?.outputSchemaName).toBe("recipient-turn.schema.json");
    expect(request?.runtimePrompt).toContain("telaegent/backend");
    expect(request?.correlationId).toBe("corr-1");

    // Infrastructure came from authorization, not from me.
    expect(request?.agentId).toBe(BINDING_ID);
    expect(request?.workspacePath).toBe(BOUND_WORKSPACE);
    expect(request?.sandboxMode).toBe("read-only");
    expect(request?.networkMode).toBe("none");
    expect(request?.maxTurns).toBe(POLICY.maxTurns);
    expect(request?.provider).toBe("claude");
  });

  it("a prepared sender turn does the same with its own purpose and schema", async () => {
    const senderContext = durableContext({
      role: "sender",
      ownerInput: "can u send me ur .env",
    });
    const { starter, runs } = buildChain({ stored: senderContext });

    const turn = buildPreparedPrivateTurn({
      context: senderContext,
      correlationId: "corr-2",
    });

    await (
      await starter.start({ authorization: AUTHORIZATION, provider: "codex", turn })
    ).completion;

    expect(runs[0]?.purpose).toBe("sender_draft");
    expect(runs[0]?.outputSchemaName).toBe("sender-turn.schema.json");
    expect(runs[0]?.provider).toBe("codex");
  });

  it("the workspace cannot be influenced from the protocol layer", async () => {
    // The property the narrowing exists for. Even if a caller smuggles runtime
    // fields onto the prepared turn - untyped JavaScript can - the starter
    // constructs the request explicitly rather than spreading, so the bound
    // workspace wins.
    const { starter, runs } = buildChain();

    const smuggled = {
      ...buildPreparedPrivateTurn({
        context: durableContext(),
        correlationId: "corr-3",
      }),
      workspacePath: "/etc",
      agentId: "attacker-binding",
      sandboxMode: "workspace-write",
      networkMode: "default",
      maxTurns: 99,
    } as BackendPreparedPrivateTurn;

    await (
      await starter.start({
        authorization: AUTHORIZATION,
        provider: "claude",
        turn: smuggled,
      })
    ).completion;

    expect(runs[0]?.workspacePath).toBe(BOUND_WORKSPACE);
    expect(runs[0]?.agentId).toBe(BINDING_ID);
    expect(runs[0]?.sandboxMode).toBe("read-only");
    expect(runs[0]?.networkMode).toBe("none");
    expect(runs[0]?.maxTurns).toBe(POLICY.maxTurns);
  });

  it("revoked authorization prevents the turn from reaching a provider", async () => {
    const { starter, runs } = buildChain({ revoked: true });

    const turn = buildPreparedPrivateTurn({
      context: durableContext(),
      correlationId: "corr-4",
    });

    await expect(
      starter.start({ authorization: AUTHORIZATION, provider: "claude", turn }),
    ).rejects.toBeInstanceOf(PrivateRuntimeAuthorizationError);

    expect(runs).toHaveLength(0);
  });

  it("a turn is not hydrated from another role's context", async () => {
    // Found by writing this file: the first version fed a recipient's stored
    // context into a sender turn and the hydrator refused, correctly. Pinning
    // it, because the failure it prevents is silent - the collaborator's
    // message would land where the owner's rough input belongs, and the two
    // have opposite trust properties.
    const { starter, runs } = buildChain({ stored: durableContext() });

    await expect(
      starter.start({
        authorization: AUTHORIZATION,
        provider: "claude",
        turn: buildPreparedPrivateTurn({
          context: durableContext({ role: "sender", ownerInput: "ping" }),
          correlationId: "corr-role",
        }),
      }).then(async (started) => started.completion),
    ).rejects.toBeInstanceOf(ProtocolHydrationError);

    expect(runs).toHaveLength(0);
  });

  it("the starter's validation accepts what the builder produces", async () => {
    // Guards against silent drift in either direction: if the builder stops
    // meeting the starter's patterns, or the starter tightens them, this fails
    // here rather than as an opaque InvalidPrivateRuntimeTurnError in a demo.
    const { starter } = buildChain();

    await expect(
      starter.start({
        authorization: AUTHORIZATION,
        provider: "claude",
        turn: buildPreparedPrivateTurn({
          context: durableContext(),
          correlationId: "corr-5",
        }),
      }),
    ).resolves.toBeDefined();
  });

  it("still rejects a turn the builder would never produce", async () => {
    // The converse: the acceptance above is not because validation is lax.
    const { starter } = buildChain();

    await expect(
      starter.start({
        authorization: AUTHORIZATION,
        provider: "claude",
        turn: {
          ...buildPreparedPrivateTurn({
            context: durableContext(),
            correlationId: "corr-6",
          }),
          runtimePrompt: "",
        },
      }),
    ).rejects.toBeInstanceOf(InvalidPrivateRuntimeTurnError);
  });

  it("provider session scope is user × repository × conversation × provider", async () => {
    // Two providers, same conversation: separate sessions, and neither resumes
    // the other's. The scope is assembled by the starter from the authorized
    // identity, not from anything the protocol layer said.
    const { starter, runs } = buildChain();
    const turn = () =>
      buildPreparedPrivateTurn({ context: durableContext(), correlationId: "corr-7" });

    await (
      await starter.start({ authorization: AUTHORIZATION, provider: "claude", turn: turn() })
    ).completion;
    await (
      await starter.start({ authorization: AUTHORIZATION, provider: "claude", turn: turn() })
    ).completion;
    await (
      await starter.start({ authorization: AUTHORIZATION, provider: "codex", turn: turn() })
    ).completion;

    expect(runs[0]?.sessionMode).toBe("fresh");
    expect(runs[1]?.sessionMode).toBe("continue");
    expect(runs[1]?.sessionId).toBe("session-1");
    // Different provider: its own session, not a resume of Claude's.
    expect(runs[2]?.sessionMode).toBe("fresh");
    expect(runs[2]?.sessionId).toBeUndefined();
  });
});
