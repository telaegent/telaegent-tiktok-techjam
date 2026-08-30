/**
 * MEMORY TESTS — hien.md §12's third suite, and questions 11 and 12.
 *
 * Until Phuong's `ProviderSessionManager` landed, these two questions —
 * "how does behaviour differ between fresh and resumed sessions?" and "what
 * happens when provider memory is lost?" — could only be answered on paper.
 * They are behavioural questions about a component that did not exist yet.
 *
 * Now they are testable, and deterministically: a fake runtime records what it
 * was asked to run, so "did Telaegent rebuild the context?" becomes an
 * assertion about a recorded request rather than a judgement about a model's
 * answer. No provider is called and nothing is billed.
 *
 * The property under test throughout is the one the whole design rests on:
 *
 *   losing a provider session must degrade into a longer prompt,
 *   never into a failed turn or a forgotten conversation.
 */

import { describe, expect, it } from "vitest";

import {
  InMemoryProviderSessionStore,
  ProviderSessionManager,
  type ManagedAgentTurnRequest,
  type ProviderSessionRuntime,
  type ProviderSessionScope,
} from "../../provider-session-manager.js";
import { RuntimeProviderError } from "../../runtime-errors.js";
import type {
  MiddlewareRunRequest,
  NormalizedRunResult,
} from "../../runtime-contract.js";

import { PROJECT_CONSTANT } from "./corpus/memory-cases.js";
import type { ProjectFacts, SharedTurn } from "./contract.js";
import { compactSummary, rehydrationContext } from "./memory.js";
import {
  buildTurnRequest,
  createProtocolHydrator,
  toTurnInput,
  type DurableConversationContext,
} from "./runtime-adapter.js";

/* ========================================================================== *
 * Fixtures
 * ========================================================================== */

const SCOPE: ProviderSessionScope = {
  userId: "user-justin",
  // Renamed and retyped on main: ProviderSessionScope now carries
  // `githubRepositoryId`, a decimal string validated against
  // /^[1-9][0-9]{0,19}$/. The old "repo-123" was not a valid GitHub id and the
  // manager rejected the whole scope. Worth noting the two sides converged
  // independently — ProjectFacts already keyed on githubRepositoryId, for the
  // same reason khoa.md gives: the stable numeric id is the real scope key,
  // because a repository can be renamed.
  githubRepositoryId: "123",
  conversationId: "conv-1",
  provider: "claude",
};

const FACTS: ProjectFacts = {
  repositoryFullName: "telaegent/backend",
  githubRepositoryId: "123",
  branch: "feat/auth",
  commit: "0123456789abcdef0123456789abcdef01234567",
  ownerName: "Justin",
  collaboratorName: "Phuong",
};

/** History whose decisive fact exists only in conversation, never in a repo. */
function historyWithAgreedConstant(length: number): SharedTurn[] {
  const turns: SharedTurn[] = [
    {
      id: "h0",
      author: "Phuong",
      origin: "human",
      text:
        "We agreed the rotation grace window for this project is " +
        PROJECT_CONSTANT +
        " milliseconds.",
      at: "2026-08-28T09:00:00.000Z",
    },
  ];
  for (let index = 1; index < length; index += 1) {
    turns.push({
      id: "h" + String(index),
      author: index % 2 === 0 ? "Phuong" : "Justin",
      origin: "agent",
      text: "Unrelated build tooling message number " + String(index) + ".",
      at: "2026-08-28T09:" + String(index).padStart(2, "0") + ":00.000Z",
    });
  }
  return turns;
}

function durableContext(
  overrides: Partial<DurableConversationContext> = {},
): DurableConversationContext {
  return {
    role: "recipient",
    facts: FACTS,
    sharedHistory: historyWithAgreedConstant(20),
    projectFacts: ["repository telaegent/backend", "branch feat/auth"],
    incomingMessage: "What rotation grace window did we agree on?",
    ...overrides,
  };
}

function baseRequest(): ManagedAgentTurnRequest {
  return {
    agentId: "agent-1",
    purpose: "recipient_answer",
    workspacePath: "/workspaces/user-justin/repo-123",
    // Deliberately empty: a resumed session needs no context, so the un-hydrated
    // request carries none. Any context in the recorded run therefore came from
    // rehydration and nowhere else.
    runtimePrompt: "",
    persistedSummary: "",
    sandboxMode: "read-only",
    networkMode: "none",
    outputSchemaName: "recipient-turn.schema.json",
    correlationId: "corr-1",
    maxTurns: 3,
  };
}

/**
 * A runtime that records every request and can be told to lose a session once.
 *
 * The failure fires only on a request that carries a `sessionId` — that is, an
 * attempt to *resume*. An earlier version failed on the first call of any kind,
 * which made the "session lost" test actually exercise "the very first turn
 * exploded" — a different scenario with a different correct behaviour. Losing a
 * session you never had is not a thing that happens.
 */
function recordingRuntime(options: { sessionLostOnce?: boolean } = {}): {
  runtime: ProviderSessionRuntime;
  runs: MiddlewareRunRequest[];
} {
  const runs: MiddlewareRunRequest[] = [];
  let shouldFail = options.sessionLostOnce === true;

  const runtime: ProviderSessionRuntime = {
    async run(request: MiddlewareRunRequest): Promise<NormalizedRunResult> {
      runs.push(request);
      if (shouldFail && request.sessionId !== undefined) {
        shouldFail = false;
        throw new RuntimeProviderError(
          "RUNTIME_SESSION_NOT_FOUND",
          "provider session is gone",
        );
      }
      return {
        provider: request.provider,
        sessionId: "session-" + String(runs.length),
        final: { ok: true },
        changedFiles: [],
        exitCode: 0,
        durationMs: 1,
      };
    },
  };

  return { runtime, runs };
}

/* ========================================================================== *
 * Q11 — fresh versus resumed
 * ========================================================================== */

describe("Q11: fresh versus resumed sessions", () => {
  it("a first turn has no session, so it hydrates and starts fresh", async () => {
    const { runtime, runs } = recordingRuntime();
    const store = new InMemoryProviderSessionStore();
    let hydrations = 0;
    const manager = new ProviderSessionManager(
      runtime,
      store,
      createProtocolHydrator({
        load: async () => {
          hydrations += 1;
          return durableContext();
        },
      }),
    );

    await manager.run(SCOPE, baseRequest());

    expect(hydrations).toBe(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sessionMode).toBe("fresh");
    expect(runs[0]?.sessionId).toBeUndefined();
    // The context came from Telaegent, not the provider.
    expect(runs[0]?.runtimePrompt).toContain(PROJECT_CONSTANT);
  });

  it("a second turn resumes and does NOT re-inject the whole conversation", async () => {
    // The efficiency half of the memory design. If a resumed turn paid the full
    // rehydration cost every time, provider sessions would buy nothing and M2
    // would be the honest recommendation.
    const { runtime, runs } = recordingRuntime();
    const store = new InMemoryProviderSessionStore();
    let hydrations = 0;
    const manager = new ProviderSessionManager(
      runtime,
      store,
      createProtocolHydrator({
        load: async () => {
          hydrations += 1;
          return durableContext();
        },
      }),
    );

    await manager.run(SCOPE, baseRequest());
    await manager.run(SCOPE, baseRequest());

    expect(hydrations).toBe(1);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.sessionMode).toBe("continue");
    expect(runs[1]?.sessionId).toBe("session-1");
    expect(runs[1]?.runtimePrompt).toBe("");
  });

  it("an explicitly fresh turn starts clean WITHOUT hydrating", async () => {
    // A distinction worth protecting: `fresh` is the caller choosing to start
    // over, which is not the same as the system recovering from loss. Hydrating
    // here would silently defeat the caller's intent.
    const { runtime, runs } = recordingRuntime();
    const store = new InMemoryProviderSessionStore();
    let hydrations = 0;
    const manager = new ProviderSessionManager(
      runtime,
      store,
      createProtocolHydrator({
        load: async () => {
          hydrations += 1;
          return durableContext();
        },
      }),
    );

    await manager.run(SCOPE, baseRequest());
    await manager.run(SCOPE, { ...baseRequest(), sessionMode: "fresh" });

    expect(hydrations).toBe(1);
    expect(runs[1]?.sessionMode).toBe("fresh");
    expect(runs[1]?.runtimePrompt).toBe("");
  });

  it("an ephemeral turn neither hydrates nor stores a session", async () => {
    const { runtime, runs } = recordingRuntime();
    const store = new InMemoryProviderSessionStore();
    let hydrations = 0;
    const manager = new ProviderSessionManager(
      runtime,
      store,
      createProtocolHydrator({
        load: async () => {
          hydrations += 1;
          return durableContext();
        },
      }),
    );

    await manager.run(SCOPE, { ...baseRequest(), sessionMode: "ephemeral" });

    expect(hydrations).toBe(0);
    expect(runs[0]?.sessionMode).toBe("ephemeral");
    expect(await store.get(SCOPE)).toBeNull();
  });
});

/* ========================================================================== *
 * Q12 — provider memory lost
 * ========================================================================== */

describe("Q12: what happens when provider memory is lost", () => {
  it("a lost session is rebuilt from Telaegent's durable conversation", async () => {
    // The headline claim of the whole memory design, as a passing assertion
    // rather than a paragraph: the agreed constant exists ONLY in conversation
    // history, so its presence in the recovery prompt proves the rebuild used
    // Telaegent's database and not a provider's memory.
    const { runtime, runs } = recordingRuntime({ sessionLostOnce: true });
    const store = new InMemoryProviderSessionStore();
    let hydrations = 0;
    const manager = new ProviderSessionManager(
      runtime,
      store,
      createProtocolHydrator({
        load: async () => {
          hydrations += 1;
          return durableContext();
        },
      }),
    );

    // Turn 1 establishes a session; turn 2 finds it gone at the provider.
    await manager.run(SCOPE, baseRequest());
    await manager.run(SCOPE, baseRequest());

    expect(hydrations).toBe(2);
    expect(runs).toHaveLength(3); // fresh, failed continue, recovered fresh

    const recovery = runs[2];
    expect(recovery?.sessionMode).toBe("fresh");
    expect(recovery?.runtimePrompt).toContain(PROJECT_CONSTANT);
    expect(recovery?.persistedSummary.length).toBeGreaterThan(0);
  });

  it("session loss degrades into a longer prompt, not a failed turn", async () => {
    const { runtime } = recordingRuntime({ sessionLostOnce: true });
    const store = new InMemoryProviderSessionStore();
    const manager = new ProviderSessionManager(
      runtime,
      store,
      createProtocolHydrator({ load: async () => durableContext() }),
    );

    await manager.run(SCOPE, baseRequest());
    const result = await manager.run(SCOPE, baseRequest());

    expect(result.exitCode).toBe(0);
    expect(await store.get(SCOPE)).not.toBeNull();
  });

  it("a hydrator that cannot load context returns the request unchanged", async () => {
    // Failure of last resort. Throwing here would convert "we lost the session"
    // into "the turn failed" — exactly the degradation the design exists to
    // avoid — so the turn proceeds with whatever context it already had.
    const { runtime, runs } = recordingRuntime();
    const store = new InMemoryProviderSessionStore();
    const manager = new ProviderSessionManager(
      runtime,
      store,
      createProtocolHydrator({ load: async () => null }),
    );

    const result = await manager.run(SCOPE, baseRequest());

    expect(result.exitCode).toBe(0);
    expect(runs[0]?.runtimePrompt).toBe("");
  });

  it("refuses to hydrate a conversation with another project's history", async () => {
    // A plumbing bug, not an attack: the scope says repository 123, the store
    // hands back context for 999. Nothing downstream could detect that the
    // wrong project's conversation had been injected, so the hydrator declines
    // and the turn proceeds with less context rather than wrong context.
    const { runtime, runs } = recordingRuntime();
    const store = new InMemoryProviderSessionStore();
    const mismatches: string[] = [];

    const manager = new ProviderSessionManager(
      runtime,
      store,
      createProtocolHydrator({
        load: async () =>
          durableContext({
            facts: { ...FACTS, githubRepositoryId: "999" },
          }),
        onScopeMismatch: (scope) => mismatches.push(scope.githubRepositoryId),
      }),
    );

    const result = await manager.run(SCOPE, baseRequest());

    expect(mismatches).toEqual(["123"]);
    expect(runs[0]?.runtimePrompt).toBe("");
    expect(runs[0]?.runtimePrompt).not.toContain(PROJECT_CONSTANT);
    // Reported, not thrown: the turn still completes.
    expect(result.exitCode).toBe(0);
  });

  it("recovery never fabricates a session id", async () => {
    const { runtime, runs } = recordingRuntime({ sessionLostOnce: true });
    const store = new InMemoryProviderSessionStore();
    const manager = new ProviderSessionManager(
      runtime,
      store,
      createProtocolHydrator({ load: async () => durableContext() }),
    );

    await manager.run(SCOPE, baseRequest());
    await manager.run(SCOPE, baseRequest());

    expect(runs[2]?.sessionId).toBeUndefined();
  });
});

/* ========================================================================== *
 * Isolation
 * ========================================================================== */

describe("session scope isolation", () => {
  it("two conversations in the same repository do not share a session", async () => {
    const { runtime, runs } = recordingRuntime();
    const store = new InMemoryProviderSessionStore();
    const manager = new ProviderSessionManager(
      runtime,
      store,
      createProtocolHydrator({ load: async () => durableContext() }),
    );

    await manager.run(SCOPE, baseRequest());
    await manager.run({ ...SCOPE, conversationId: "conv-2" }, baseRequest());

    expect(runs[1]?.sessionMode).toBe("fresh");
    expect(runs[1]?.sessionId).toBeUndefined();
  });

  it("the same conversation on a different provider starts its own session", async () => {
    // phuong.md §12: switching Claude to Codex must not lose the collaboration,
    // and must not silently reuse the other provider's session either.
    const { runtime, runs } = recordingRuntime();
    const store = new InMemoryProviderSessionStore();
    const manager = new ProviderSessionManager(
      runtime,
      store,
      createProtocolHydrator({ load: async () => durableContext() }),
    );

    await manager.run(SCOPE, baseRequest());
    await manager.run({ ...SCOPE, provider: "codex" }, baseRequest());

    expect(runs[1]?.sessionMode).toBe("fresh");
    // The conversation survives the switch: the agreed constant is present.
    expect(runs[1]?.runtimePrompt).toContain(PROJECT_CONSTANT);
  });
});

/* ========================================================================== *
 * Adapter shape
 * ========================================================================== */

describe("runtime adapter", () => {
  it("builds a read-only, network-less turn request", async () => {
    // Not parameters by design: both agent jobs read and draft, neither writes
    // and neither needs the network. A prompt-injection case that persuades the
    // agent to modify the repository should fail at the OS boundary.
    const request = buildTurnRequest({
      context: durableContext(),
      workspacePath: "/workspaces/justin/repo-123",
      agentId: "agent-1",
      correlationId: "corr-1",
    });

    expect(request.sandboxMode).toBe("read-only");
    expect(request.networkMode).toBe("none");
    expect(request.purpose).toBe("recipient_answer");
    expect(request.outputSchemaName).toBe("recipient-turn.schema.json");
  });

  it("uses the sender purpose and schema for a sender turn", () => {
    const request = buildTurnRequest({
      context: durableContext({
        role: "sender",
        ownerInput: "ask about the rotation window",
      }),
      workspacePath: "/workspaces/justin/repo-123",
      agentId: "agent-1",
      correlationId: "corr-1",
    });

    expect(request.purpose).toBe("sender_draft");
    expect(request.outputSchemaName).toBe("sender-turn.schema.json");
  });

  it("never sets provider, sessionId or sessionMode implicitly", () => {
    // The session manager owns those three. A hydrator or builder that forced
    // `sessionMode: "fresh"` would defeat the manager's recovery sequence.
    const request = buildTurnRequest({
      context: durableContext(),
      workspacePath: "/workspaces/justin/repo-123",
      agentId: "agent-1",
      correlationId: "corr-1",
    });

    expect("provider" in request).toBe(false);
    expect("sessionId" in request).toBe(false);
    expect(request.sessionMode).toBeUndefined();
  });

  it("takes project facts from durable context, never from the request", () => {
    // phuong.md §7: a remote collaborator must not influence repository id,
    // branch or commit, because those decide which files an agent can reach.
    const input = toTurnInput(durableContext());
    expect(input.facts.githubRepositoryId).toBe("123");
    expect(input.facts.branch).toBe("feat/auth");
  });

  it("bounds the persisted summary", () => {
    const request = buildTurnRequest({
      context: durableContext({ sharedHistory: historyWithAgreedConstant(300) }),
      workspacePath: "/workspaces/justin/repo-123",
      agentId: "agent-1",
      correlationId: "corr-1",
    });
    expect(request.persistedSummary.length).toBeLessThanOrEqual(1_000);
  });

  it("rehydration remains a pure function of durable rows", () => {
    // If this ever stops holding, recovery has acquired a hidden dependency and
    // the claim that a lost session is recoverable is no longer true.
    const history = historyWithAgreedConstant(15);
    const facts = ["repository telaegent/backend"];
    expect(rehydrationContext(history, facts)).toEqual(
      rehydrationContext(history, facts),
    );
    expect(compactSummary(history, facts)).toBe(compactSummary(history, facts));
  });
});
