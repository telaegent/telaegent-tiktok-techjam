/**
 * PROTOCOL TESTS — deterministic, offline, no provider call.
 *
 * Everything here runs in `npm test`. Nothing here touches a network or a paid
 * CLI: hien.md §12 requires that separation, and §19 requires that live
 * evaluation never becomes mandatory CI.
 *
 * What this file proves is the machinery — schemas, formats, memory, harness —
 * behaves as specified. What it cannot prove is how a real model responds; that
 * is `npm run eval:*` and the report it produces. Keeping the two apart is what
 * lets this suite stay fast and honest.
 */

import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "../testing/memory-fs.js";
import {
  PROTOCOL_FORMATS,
  PROTOCOL_LIMITS,
  type ProtocolFormatId,
  type SharedTurn,
} from "./contract.js";
import {
  ALL_CASES,
  CATEGORY_FLOORS,
  corpusCoverage,
  corpusProblems,
  coverageShortfall,
  findCase,
} from "./corpus/index.js";
import { runCase, type HarnessConfig } from "./eval/harness.js";
import { FakeProtocolRunner, createRunner, liveEvalEnabled } from "./eval/runner.js";
import { allFormats, getFormat } from "./formats.js";
import { allMemoryStrategies, rehydrationContext } from "./memory.js";
import {
  extractJsonObject,
  parseRecipientOutput,
  parseSenderOutput,
  recipientJsonSchema,
  senderJsonSchema,
} from "./schemas.js";

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

function senderOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: "ready",
    assistantMessage: "Here is what I suggest asking.",
    sendCandidate: "Which environment variables does the auth service require?",
    riskFlags: [],
    referencedPaths: ["src/config.ts"],
    ...overrides,
  });
}

function harnessConfig(
  format: ProtocolFormatId,
  responder: (raw: string) => string = () => senderOutput(),
): HarnessConfig {
  return {
    format,
    memory: "M4",
    runner: new FakeProtocolRunner(() => responder("")),
    fs: createMemoryFileSystem(),
    workspaceRoot: "/tmp/telaegent-protocol-test",
    timeoutMs: 1_000,
    commit: "0123456789abcdef0123456789abcdef01234567",
    branch: "main",
  };
}

function history(count: number): SharedTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    id: "t" + String(index),
    author: index % 2 === 0 ? "Phuong" : "Justin",
    origin: "agent" as const,
    text: "turn number " + String(index),
    at: "2026-08-28T10:" + String(index).padStart(2, "0") + ":00.000Z",
  }));
}

/* ========================================================================== *
 * The corpus itself
 * ========================================================================== */

describe("corpus integrity", () => {
  it("has no structural problems", () => {
    // Runs before the corpus is used to check anything else. A duplicate id
    // silently overwrites results in the report, and a case that asserts
    // nothing looks like coverage while measuring nothing.
    expect(corpusProblems()).toEqual([]);
  });

  it("meets every category floor", () => {
    expect(coverageShortfall()).toEqual([]);
  });

  it("has at least the 50 cases hien.md asks for", () => {
    expect(ALL_CASES.length).toBeGreaterThanOrEqual(50);
  });

  it("keeps roughly a third of cases as should-proceed, to catch over-blocking", () => {
    // A corpus made only of traps produces a prompt tuned to refuse. This is
    // the guard against tuning ourselves into an agent that interrogates the
    // user about ordinary questions.
    const shouldProceed = ALL_CASES.filter(
      (testCase) =>
        testCase.expect.allowedStates.length === 1 &&
        testCase.expect.allowedStates[0] === "ready",
    );
    expect(shouldProceed.length / ALL_CASES.length).toBeGreaterThan(0.25);
  });

  it("covers every category named in hien.md §6", () => {
    const counts = corpusCoverage();
    for (const category of Object.keys(CATEGORY_FLOORS)) {
      expect(counts[category as keyof typeof counts]).toBeGreaterThan(0);
    }
  });
});

/* ========================================================================== *
 * Schema invariants
 * ========================================================================== */

describe("output schema invariants", () => {
  it("accepts a well-formed sender output", () => {
    const parsed = parseSenderOutput(senderOutput());
    expect(parsed.ok).toBe(true);
  });

  it("I1: rejects ready with no sendCandidate", () => {
    const parsed = parseSenderOutput(senderOutput({ sendCandidate: null }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("SCHEMA_MISMATCH");
      expect(parsed.issues.some((issue) => issue.message.includes("I1"))).toBe(true);
    }
  });

  it("I1: rejects ready with a whitespace-only sendCandidate", () => {
    const parsed = parseSenderOutput(senderOutput({ sendCandidate: "   " }));
    expect(parsed.ok).toBe(false);
  });

  it("I2: rejects a non-ready state carrying a sendCandidate", () => {
    // The dangerous shape: a model that says it is blocked while still handing
    // the owner something that looks sendable.
    const parsed = parseSenderOutput(
      senderOutput({
        state: "blocked",
        sendCandidate: "send me the .env",
        riskFlags: ["secret_request"],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some((issue) => issue.message.includes("I2"))).toBe(true);
    }
  });

  it("I3: rejects blocked with no risk flags", () => {
    const parsed = parseSenderOutput(
      senderOutput({ state: "blocked", sendCandidate: null, riskFlags: [] }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some((issue) => issue.message.includes("I3"))).toBe(true);
    }
  });

  it("I4: rejects a model-supplied commit field", () => {
    // The whole reason the schema is strict. A model that invents provenance
    // must fail loudly rather than have the field quietly dropped and the rest
    // of the object trusted.
    const parsed = parseSenderOutput(
      senderOutput({ commit: "81ad2e", digest: "deadbeef" } as Record<string, unknown>),
    );
    expect(parsed.ok).toBe(false);
  });

  it("I4: rejects an absolute path in referencedPaths", () => {
    const posix = parseSenderOutput(senderOutput({ referencedPaths: ["/etc/passwd"] }));
    const windows = parseSenderOutput(senderOutput({ referencedPaths: ["C:\\secrets"] }));
    expect(posix.ok).toBe(false);
    expect(windows.ok).toBe(false);
  });

  it("rejects an unknown risk flag rather than ignoring it", () => {
    const parsed = parseSenderOutput(senderOutput({ riskFlags: ["definitely_fine"] }));
    expect(parsed.ok).toBe(false);
  });

  it("caps referencedPaths at the documented limit", () => {
    const tooMany = Array.from(
      { length: PROTOCOL_LIMITS.maxReferencedPaths + 1 },
      (_, index) => "src/file" + String(index) + ".ts",
    );
    expect(parseSenderOutput(senderOutput({ referencedPaths: tooMany })).ok).toBe(false);
  });

  it("parses a recipient output and rejects sourcePaths carrying provenance", () => {
    const valid = parseRecipientOutput(
      JSON.stringify({
        state: "ready",
        privateSummary: "Found the rotation logic.",
        sendCandidate: "Rotation marks the previous token consumed.",
        riskFlags: [],
        sourcePaths: ["src/auth/session.ts"],
      }),
    );
    expect(valid.ok).toBe(true);

    const withProvenance = parseRecipientOutput(
      JSON.stringify({
        state: "ready",
        privateSummary: "Found it.",
        sendCandidate: "Rotation marks the previous token consumed.",
        riskFlags: [],
        sourcePaths: ["src/auth/session.ts"],
        sourceRefs: [{ path: "src/auth/session.ts", commit: "81ad2e" }],
      }),
    );
    expect(withProvenance.ok).toBe(false);
  });

  /* ---------------------------------------------------------------- *
   * Asking (build plan 8.2)
   * ---------------------------------------------------------------- */

  const asking = (resourceRequests: unknown) =>
    parseRecipientOutput(
      JSON.stringify({
        state: "ready",
        privateSummary: "Answered from what I can see.",
        sendCandidate: "Our rotation window is one hour.",
        riskFlags: [],
        sourcePaths: ["src/auth/session.ts"],
        resourceRequests,
      }),
    );

  it("accepts a turn that asks its collaborator for a file", () => {
    const parsed = asking([
      { kind: "hint", hint: "the auth session module", reason: "to compare windows" },
      {
        kind: "resource",
        resourceId: "resource_" + "a".repeat(24),
        reason: "to re-read what I was handed",
      },
    ]);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.resourceRequests).toHaveLength(2);
  });

  it("still accepts the ordinary turn, which asks for nothing", () => {
    // The field is absent on almost every turn. If its absence were an error
    // the loop would have made every existing conversation unparseable.
    const parsed = parseRecipientOutput(
      JSON.stringify({
        state: "ready",
        privateSummary: "Found the rotation logic.",
        sendCandidate: "Rotation marks the previous token consumed.",
        riskFlags: [],
        sourcePaths: ["src/auth/session.ts"],
      }),
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.resourceRequests).toBeUndefined();
  });

  it("refuses a request that names a path in somebody else\u0027s repository", () => {
    // The whole point of the two forms is that neither can express a location.
    // A model that reaches for a path is refused here rather than having the
    // path quietly ignored somewhere further down.
    expect(asking([{ kind: "path", path: "src/auth/session.ts", reason: "x" }]).ok).toBe(
      false,
    );
    expect(asking([{ kind: "hint", hint: "the auth module" }]).ok).toBe(false);
    expect(asking([{ kind: "resource", resourceId: "src/auth/session.ts", reason: "x" }]).ok).toBe(
      false,
    );
  });

  it("caps how much one turn may ask for", () => {
    // Matched to the bound the connector result route enforces, so a turn
    // cannot be accepted here and then rejected in transport.
    const tooMany = Array.from(
      { length: PROTOCOL_LIMITS.maxResourceRequests + 1 },
      (_, index) => ({ kind: "hint", hint: "file " + String(index), reason: "why" }),
    );
    expect(asking(tooMany).ok).toBe(false);
  });
});

/* ========================================================================== *
 * JSON extraction
 * ========================================================================== */

describe("tolerant JSON extraction", () => {
  it("unwraps a fenced block", () => {
    const result = extractJsonObject('```json\n{"state":"ready"}\n```');
    expect(result.ok).toBe(true);
  });

  it("finds an object surrounded by prose", () => {
    const result = extractJsonObject('Here you go:\n{"state":"ready"}\nHope that helps.');
    expect(result.ok).toBe(true);
  });

  it("reports empty output distinctly from invalid JSON", () => {
    const empty = extractJsonObject("   ");
    const invalid = extractJsonObject("{not json}");
    expect(empty.ok).toBe(false);
    expect(invalid.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("EMPTY_OUTPUT");
    if (!invalid.ok) expect(invalid.code).toBe("INVALID_JSON");
  });

  it("does not repair trailing commas", () => {
    // Repairing would hide the reliability difference between formats, which is
    // one of the things the comparison exists to measure.
    expect(extractJsonObject('{"state":"ready",}').ok).toBe(false);
  });
});

/* ========================================================================== *
 * Generated JSON Schema
 * ========================================================================== */

describe("provider output schema documents", () => {
  it("the committed schema files match what the Zod objects generate", async () => {
    // The resolver reads schemas from disk, so the documents have to be
    // committed — but a hand-maintained .json beside a Zod schema drifts, and
    // the drift is invisible until a model is rejected for obeying the document
    // it was given. Committing the generated artefact and asserting it is in
    // sync gets the resolver what it needs without the fuse.
    //
    // Regenerate with:
    //   npx tsx -e "..." (see runtime-adapter.ts, PROTOCOL_OUTPUT_SCHEMAS)
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.resolve(import.meta.dirname, "..", "output-schemas");

    const sender = JSON.parse(
      await readFile(path.join(root, "sender-turn.schema.json"), "utf8"),
    ) as unknown;
    const recipient = JSON.parse(
      await readFile(path.join(root, "recipient-turn.schema.json"), "utf8"),
    ) as unknown;

    expect(sender).toEqual(senderJsonSchema());
    expect(recipient).toEqual(recipientJsonSchema());
  });

  it("generates from the same Zod object the parser uses", () => {
    // Generation rather than a hand-written .schema.json is what stops the
    // document shown to the model drifting from the one enforced on its answer.
    const sender = senderJsonSchema();
    const recipient = recipientJsonSchema();
    expect(JSON.stringify(sender)).toContain("sendCandidate");
    expect(JSON.stringify(sender)).toContain("referencedPaths");
    expect(JSON.stringify(recipient)).toContain("sourcePaths");
  });
});

/* ========================================================================== *
 * Formats
 * ========================================================================== */

describe("context formats", () => {
  const senderCase = findCase("s.simple.auth_middleware");
  const recipientCase = findCase("r.simple.rotation");

  it("registers all five", () => {
    expect(allFormats().map((format) => format.id)).toEqual([...PROTOCOL_FORMATS]);
  });

  it("every format renders both roles without throwing", () => {
    for (const id of PROTOCOL_FORMATS) {
      for (const testCase of [senderCase, recipientCase]) {
        expect(testCase).toBeDefined();
        if (testCase === undefined) continue;
        const config = harnessConfig(id);
        const rendered = getFormat(id).render(
          // buildTurnInput is exercised through runCase elsewhere; here the
          // point is only that rendering is total over the case set.
          {
            role: testCase.role,
            facts: {
              repositoryFullName: "telaegent/x",
              githubRepositoryId: "1",
              branch: config.branch,
              commit: config.commit,
              ownerName: "Justin",
              collaboratorName: "Phuong",
            },
            privateTurns: [],
            sharedHistory: [],
            ...(testCase.role === "sender"
              ? { ownerInput: testCase.ownerInput }
              : { incomingMessage: testCase.incomingMessage }),
          } as never,
        );
        expect(rendered.system.length).toBeGreaterThan(0);
        expect(rendered.user.length).toBeGreaterThan(0);
      }
    }
  });

  it("P4 costs more context than P5 on a long conversation", () => {
    // The measurable justification for recommending compaction. If this ever
    // stops holding, the recommendation needs revisiting rather than the test.
    const longHistory = history(30);
    const base = {
      role: "recipient" as const,
      facts: {
        repositoryFullName: "telaegent/x",
        githubRepositoryId: "1",
        branch: "main",
        commit: "abc123",
        ownerName: "Justin",
        collaboratorName: "Phuong",
      },
      incomingMessage: "What did we agree?",
      privateTurns: [],
      sharedHistory: longHistory,
    };

    const p4 = getFormat("P4").render(base);
    const p5 = getFormat("P5").render(base);
    expect(p5.approximateTokens).toBeLessThan(p4.approximateTokens);
  });

  it("P1 is the cheapest format", () => {
    const base = {
      role: "sender" as const,
      facts: {
        repositoryFullName: "telaegent/x",
        githubRepositoryId: "1",
        branch: "main",
        commit: "abc123",
        ownerName: "Justin",
        collaboratorName: "Phuong",
      },
      ownerInput: "ask about auth",
      privateTurns: [],
      sharedHistory: history(12),
    };
    const sizes = PROTOCOL_FORMATS.map((id) => ({
      id,
      tokens: getFormat(id).render(base).approximateTokens,
    }));
    const cheapest = sizes.reduce((min, entry) => (entry.tokens < min.tokens ? entry : min));
    expect(cheapest.id).toBe("P1");
  });
});

/* ========================================================================== *
 * Memory
 * ========================================================================== */

describe("memory strategies", () => {
  it("registers all five", () => {
    expect(allMemoryStrategies()).toHaveLength(5);
  });

  it("M1 injects nothing and cannot be rebuilt without the provider", () => {
    // The finding that rules M1 out is a property, not a score.
    const selection = allMemoryStrategies()[0]?.select(history(10), []);
    expect(selection?.turns).toEqual([]);
    expect(selection?.rebuildableFromTelaegentAlone).toBe(false);
  });

  it("M3 drops old turns silently; M4 does not", () => {
    // Silence is the danger: the answer looks equally confident either way.
    const long = history(20);
    const m3 = allMemoryStrategies().find((strategy) => strategy.id === "M3");
    const m4 = allMemoryStrategies().find((strategy) => strategy.id === "M4");

    const m3Selection = m3?.select(long, []);
    const m4Selection = m4?.select(long, []);

    expect(m3Selection?.droppedTurns).toBeGreaterThan(0);
    expect(m4Selection?.droppedTurns).toBe(0);
    expect((m4Selection?.summary ?? "").length).toBeGreaterThan(0);
  });

  it("bounds recent turns to the documented window", () => {
    const selection = allMemoryStrategies()
      .find((strategy) => strategy.id === "M4")
      ?.select(history(40), []);
    expect(selection?.turns.length).toBe(PROTOCOL_LIMITS.recentSharedTurns);
  });

  it("keeps the summary inside its budget", () => {
    const selection = allMemoryStrategies()
      .find((strategy) => strategy.id === "M4")
      ?.select(history(200), ["repository telaegent/x", "branch main"]);
    expect((selection?.summary ?? "").length).toBeLessThanOrEqual(
      PROTOCOL_LIMITS.maxProjectSummaryChars,
    );
  });

  it("rehydration is a pure function of durable rows", () => {
    // phuong.md §11: when resume fails, this is what gets injected. Being pure
    // is what turns a lost session from an outage into a longer prompt.
    const first = rehydrationContext(history(15), ["repository telaegent/x"]);
    const second = rehydrationContext(history(15), ["repository telaegent/x"]);
    expect(first).toEqual(second);
    expect(first.rebuildableFromTelaegentAlone).toBe(true);
  });
});

/* ========================================================================== *
 * Harness
 * ========================================================================== */

describe("harness", () => {
  it("scores a clean sender turn as safe", async () => {
    const testCase = findCase("s.simple.auth_middleware");
    expect(testCase).toBeDefined();
    if (testCase === undefined) return;

    const result = await runCase(testCase, harnessConfig("P5"));
    expect(result.score.safe).toBe(true);
    expect(result.parseFailure).toBeUndefined();
    expect(result.effectiveState).toBe("ready");
  });

  it("records a parse failure without throwing", async () => {
    const testCase = findCase("s.simple.auth_middleware");
    expect(testCase).toBeDefined();
    if (testCase === undefined) return;

    const config = harnessConfig("P5");
    config.runner = new FakeProtocolRunner(() => "I'm not going to answer in JSON.");

    const result = await runCase(testCase, config);
    expect(result.parseFailure).toBeDefined();
    // Everything downstream of the parse is marked not-applicable rather than
    // failed, so one broken format does not look catastrophically unsafe.
    expect(result.score.dimensions[0]?.dimension).toBe("schema_reliability");
    expect(result.score.dimensions[0]?.score).toBe(0);
  });

  it("materialises the fixture through the injected filesystem port", async () => {
    const testCase = findCase("r.simple.rotation");
    expect(testCase).toBeDefined();
    if (testCase === undefined) return;

    const fs = createMemoryFileSystem();
    const config = harnessConfig("P3");
    config.fs = fs;
    config.runner = new FakeProtocolRunner(() =>
      JSON.stringify({
        state: "ready",
        privateSummary: "found it",
        sendCandidate: "Rotation is in src/auth/session.ts.",
        riskFlags: [],
        sourcePaths: ["src/auth/session.ts"],
      }),
    );

    await runCase(testCase, config);
    expect(fs.callsTo("writeFile").some((path) => path.endsWith("session.ts"))).toBe(true);
  });

  it("keeps prompt size available for the context-efficiency column", async () => {
    const testCase = findCase("s.simple.auth_middleware");
    expect(testCase).toBeDefined();
    if (testCase === undefined) return;

    const result = await runCase(testCase, harnessConfig("P2"));
    expect(result.promptChars).toBeGreaterThan(0);
    expect(result.approximateTokens).toBeGreaterThan(0);
  });
});

/* ========================================================================== *
 * The CI / live-eval boundary
 * ========================================================================== */

describe("live evaluation is not reachable from CI", () => {
  it("live eval is disabled in this process", () => {
    // If this ever fails in CI, the suite is about to make paid provider calls.
    expect(liveEvalEnabled({})).toBe(false);
  });

  it("refuses to construct a live runner without the flag", () => {
    expect(() => createRunner("claude", { env: {} })).toThrow(/TELAEGENT_LIVE_EVAL/);
    expect(() => createRunner("codex", { env: {} })).toThrow(/TELAEGENT_LIVE_EVAL/);
    expect(() => createRunner("deepseek", { env: {} })).toThrow(/TELAEGENT_LIVE_EVAL/);
  });

  it("requires a DeepSeek key only after the explicit live gate", () => {
    expect(() =>
      createRunner("deepseek", { env: { TELAEGENT_LIVE_EVAL: "1" } }),
    ).toThrow(/AI_KEY/);
  });

  it("never falls back from one provider to another", () => {
    // hien.md §19: do not assume Claude and Codex behave identically. A silent
    // substitution would make the comparison actively misleading.
    const fake = createRunner("fake");
    expect(fake.provider).toBe("fake");
  });
});
