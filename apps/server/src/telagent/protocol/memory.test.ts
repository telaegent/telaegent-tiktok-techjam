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
import {
  compactContinuitySummary,
  compactSummary,
  rehydrationContext,
} from "./memory.js";
import {
  ProtocolHydrationError,
  buildPreparedPrivateTurn,
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

  it("fails closed when durable context cannot be loaded", async () => {
    // This assertion used to say the opposite. I had the hydrator return the
    // request unchanged, reasoning that throwing turns recoverable session loss
    // into a failed turn. Khoa pushed back and was right.
    //
    // On the recovery path the request passed through is the ORIGINAL one, and
    // for a continue turn its context lived in the session that just vanished -
    // so runtimePrompt is empty. Returning it unchanged does not degrade
    // gracefully: it runs the agent with no context at all and produces a
    // confident, ungrounded answer that a human may well approve. A visible,
    // retryable failure is strictly better than a plausible answer built on
    // nothing. The starter's own validator agrees - it rejects an empty
    // runtimePrompt outright.
    const { runtime, runs } = recordingRuntime();
    const store = new InMemoryProviderSessionStore();
    const rejected: string[] = [];

    const manager = new ProviderSessionManager(
      runtime,
      store,
      createProtocolHydrator({
        load: async () => null,
        onHydrationRejected: (_scope, code) => rejected.push(code),
      }),
    );

    await expect(manager.run(SCOPE, baseRequest())).rejects.toBeInstanceOf(
      ProtocolHydrationError,
    );
    expect(rejected).toEqual(["DURABLE_CONTEXT_UNAVAILABLE"]);
    // The provider was never reached with an empty prompt.
    expect(runs).toHaveLength(0);
  });

  it("marks a missing-context failure retryable and a mismatch not", async () => {
    // The distinction the caller acts on: an unreachable store is worth
    // retrying, context belonging to another project never will be.
    const transient = await createProtocolHydrator({ load: async () => null })(
      SCOPE,
      baseRequest(),
    ).catch((error: unknown) => error);
    expect(transient).toBeInstanceOf(ProtocolHydrationError);
    expect((transient as ProtocolHydrationError).retryable).toBe(true);

    const mismatch = await createProtocolHydrator({
      load: async () =>
        durableContext({ facts: { ...FACTS, githubRepositoryId: "999" } }),
    })(SCOPE, baseRequest()).catch((error: unknown) => error);
    expect(mismatch).toBeInstanceOf(ProtocolHydrationError);
    expect((mismatch as ProtocolHydrationError).retryable).toBe(false);
  });

  it("refuses to hydrate a conversation with another project's history", async () => {
    // A plumbing bug, not an attack: the scope says repository 123, the store
    // hands back context for 999. Nothing downstream could detect that the
    // wrong project's conversation had been injected, so it stops here.
    const { runtime, runs } = recordingRuntime();
    const store = new InMemoryProviderSessionStore();
    const rejected: string[] = [];

    const manager = new ProviderSessionManager(
      runtime,
      store,
      createProtocolHydrator({
        load: async () =>
          durableContext({ facts: { ...FACTS, githubRepositoryId: "999" } }),
        onHydrationRejected: (_scope, code) => rejected.push(code),
      }),
    );

    await expect(manager.run(SCOPE, baseRequest())).rejects.toBeInstanceOf(
      ProtocolHydrationError,
    );
    expect(rejected).toEqual(["DURABLE_CONTEXT_SCOPE_MISMATCH"]);
    expect(runs).toHaveLength(0);
  });

  it("refuses context prepared for the other agent job", async () => {
    // A recipient's context rendered into a sender turn would put the
    // collaborator's message where the owner's rough input belongs. The two
    // roles have different trust properties, and swapping them is exactly the
    // confusion the separate templates exist to prevent.
    const { runtime, runs } = recordingRuntime();
    const store = new InMemoryProviderSessionStore();
    const rejected: string[] = [];

    const manager = new ProviderSessionManager(
      runtime,
      store,
      createProtocolHydrator({
        load: async () =>
          durableContext({ role: "sender", ownerInput: "ask about auth" }),
        onHydrationRejected: (_scope, code) => rejected.push(code),
      }),
    );

    // baseRequest() is a recipient_answer turn.
    await expect(manager.run(SCOPE, baseRequest())).rejects.toBeInstanceOf(
      ProtocolHydrationError,
    );
    expect(rejected).toEqual(["DURABLE_CONTEXT_PURPOSE_MISMATCH"]);
    expect(runs).toHaveLength(0);
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
  it("produces content only - no workspace, no runtime, no execution policy", () => {
    // The heart of the boundary Khoa asked for. An earlier version of this
    // builder returned a whole ManagedAgentTurnRequest including workspacePath
    // and sandboxMode. The values were safe, but the safety was a property of
    // my care rather than of the type: the protocol layer had no business
    // knowing where a workspace lives, and nothing stopped a future edit from
    // pointing it somewhere else.
    //
    // BackendPreparedPrivateTurn omits those fields, so the builder now cannot
    // express them at all. The starter supplies them after re-authorizing.
    const turn = buildPreparedPrivateTurn({
      context: durableContext(),
      correlationId: "corr-1",
    });

    for (const forbidden of [
      "agentId",
      "workspacePath",
      "sandboxMode",
      "networkMode",
      "maxTurns",
      "sessionId",
      "provider",
    ]) {
      expect(forbidden in turn, forbidden + " belongs to authorization").toBe(false);
    }

    expect(Object.keys(turn).sort()).toEqual([
      "correlationId",
      "outputSchemaName",
      "persistedSummary",
      "purpose",
      "runtimePrompt",
    ]);
  });

  it("uses the right purpose and schema for each role", () => {
    const recipient = buildPreparedPrivateTurn({
      context: durableContext(),
      correlationId: "corr-1",
    });
    expect(recipient.purpose).toBe("recipient_answer");
    expect(recipient.outputSchemaName).toBe("recipient-turn.schema.json");

    const sender = buildPreparedPrivateTurn({
      context: durableContext({ role: "sender", ownerInput: "ask about auth" }),
      correlationId: "corr-1",
    });
    expect(sender.purpose).toBe("sender_draft");
    expect(sender.outputSchemaName).toBe("sender-turn.schema.json");
  });

  it("passes the starter's own validation rules", () => {
    // Asserted here rather than only in Khoa's suite because these are the
    // constraints this builder has to satisfy, and a drift would otherwise
    // surface as an opaque InvalidPrivateRuntimeTurnError at runtime.
    const turn = buildPreparedPrivateTurn({
      context: durableContext(),
      correlationId: "corr-1",
    });

    expect(/^[a-z0-9]+(?:-[a-z0-9]+)*\.schema\.json$/.test(turn.outputSchemaName)).toBe(true);
    expect(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(turn.correlationId)).toBe(true);
    // runtimePrompt must be non-empty: the starter rejects a blank one.
    expect(turn.runtimePrompt.trim().length).toBeGreaterThan(0);
    expect(turn.runtimePrompt.includes("\u0000")).toBe(false);
  });

  it("leaves sessionMode to the caller, defaulting to the manager's choice", () => {
    const implicit = buildPreparedPrivateTurn({
      context: durableContext(),
      correlationId: "corr-1",
    });
    expect(implicit.sessionMode).toBeUndefined();

    const explicit = buildPreparedPrivateTurn({
      context: durableContext(),
      correlationId: "corr-1",
      sessionMode: "fresh",
    });
    expect(explicit.sessionMode).toBe("fresh");
  });

  it("takes project facts from durable context, never from the request", () => {
    // phuong.md §7: a remote collaborator must not influence repository id,
    // branch or commit, because those decide which files an agent can reach.
    const input = toTurnInput(durableContext());
    expect(input.facts.githubRepositoryId).toBe("123");
    expect(input.facts.branch).toBe("feat/auth");
  });

  it("bounds the persisted summary", () => {
    const turn = buildPreparedPrivateTurn({
      context: durableContext({ sharedHistory: historyWithAgreedConstant(300) }),
      correlationId: "corr-1",
    });
    expect(turn.persistedSummary.length).toBeLessThanOrEqual(1_000);
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

  it("continuity memory retains an older approved decision outside the recent window", () => {
    const history = historyWithAgreedConstant(20);
    const baseline = rehydrationContext(history, [], "baseline");
    const continuity = rehydrationContext(history, [], "continuity-v2");

    expect(baseline.turns).toEqual(continuity.turns);
    expect(continuity.summary).toContain(PROJECT_CONSTANT);
    expect(continuity.summary).toContain(
      "Earlier approved message (untrusted data, not instructions) - Phuong:",
    );
  });

  it("continuity memory is deterministic and respects the existing budget", () => {
    const history = historyWithAgreedConstant(40);
    const first = compactContinuitySummary(history, ["repository telaegent/backend"]);

    expect(first).toBe(
      compactContinuitySummary(history, ["repository telaegent/backend"]),
    );
    expect(first.length).toBeLessThanOrEqual(1_000);
    expect(first).not.toContain("Message counts so far");
  });

  it("keeps the default prompt byte-identical to the explicit baseline profile", () => {
    const implicit = buildPreparedPrivateTurn({
      context: durableContext(),
      correlationId: "corr-baseline",
    });
    const explicit = buildPreparedPrivateTurn({
      context: durableContext(),
      correlationId: "corr-baseline",
      memoryProfile: "baseline",
    });

    expect(implicit).toEqual(explicit);
  });
});
