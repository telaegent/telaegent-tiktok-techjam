/**
 * LIVE PROBE — does a real provider turn actually ask for a file it cannot see?
 *
 * Build plan 8 is implemented end to end on the machine side: an ask is
 * carried, gated by a human, brokered on the owner's machine, and returned to
 * the round that asked. Every part of that is covered by deterministic tests
 * against a fake runner. One link is not, and cannot be: whether a live model,
 * given the recipient prompt and a question it genuinely cannot finish from
 * its own repository, emits a well-formed `resourceRequests` entry at all.
 *
 * The evaluation corpus does not answer this. Not one case in it is written to
 * be unanswerable from the recipient's own checkout, which is correct for what
 * the corpus measures and useless for this question.
 *
 * So this is deliberately not a corpus run. Three cases, three billable calls,
 * one question: ask, do not ask, and well-formed.
 *
 *   npm run probe:capability-ask            (requires TELAEGENT_LIVE_EVAL=1)
 *   npm run probe:capability-ask -- --runner codex --only mismatch
 *
 * Nothing here writes to Supabase or to the repository. Fixtures materialise
 * into the OS temp directory, exactly as the harness does.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectorResourceRequestSchema } from "../connectors/resource-request.js";
import { nodeFileSystemPort } from "../telagent/ports.node.js";
import type { RecipientCase } from "../telagent/protocol/corpus/types.js";
import { materializeFixture } from "../telagent/protocol/fixtures/materialize.js";
import { getFixtureRepo } from "../telagent/protocol/fixtures/repos.js";
import { getFormat } from "../telagent/protocol/formats.js";
import { buildTurnInput, type HarnessConfig } from "../telagent/protocol/eval/harness.js";
import {
  ClaudeCliRunner,
  CodexCliRunner,
  LIVE_EVAL_ENV_VAR,
  liveEvalEnabled,
  type ProtocolRunner,
} from "../telagent/protocol/eval/runner.js";
import {
  extractJsonObject,
  parseRecipientOutput,
  recipientJsonSchema,
} from "../telagent/protocol/schemas.js";

/* ========================================================================== *
 * Cases
 * ========================================================================== */

/**
 * Two asks and a control.
 *
 * The two asks are not "please read my file" in disguise. Each is a question a
 * colleague would really send, where the recipient's own repository answers
 * one half and the asker's code holds the other. That is the shape build plan
 * 8 exists for, and a model that only asks when told to ask proves nothing.
 *
 * The control is the corpus case `r.simple.rotation`, which is answerable in
 * full from `src/auth/session.ts`. It is the expensive half of the result: an
 * agent that asks for a file it does not need turns every exchange into an
 * interruption for the other person, and that failure is invisible unless a
 * case exists where the right number of requests is zero.
 */
const PROBE_CASES: RecipientCase[] = [
  {
    id: "probe.ask.caller",
    role: "recipient",
    category: "simple_repo_question",
    fixture: "simple-auth",
    incomingMessage:
      "We pulled in your session module last week and now our web client logs " +
      "people out of every open tab the first time one of them refreshes. I " +
      "need to work out whether that is your rotation invalidating the whole " +
      "session family, or our own refresh hook racing itself and consuming the " +
      "same token twice. What does your side do on a second use of a token " +
      "that was already rotated?",
    expect: {
      allowedStates: ["ready"],
      humanReviewOnly: true,
      rationale:
        "Answerable in part from session.ts; the other half is in the asker's " +
        "refresh hook, which the recipient cannot read.",
    },
  },
  {
    id: "probe.ask.mismatch",
    role: "recipient",
    category: "simple_repo_question",
    fixture: "simple-auth",
    incomingMessage:
      "Tokens from your service start failing against our gateway with a 401 " +
      "after about fifteen minutes, even though we configured a 24 hour " +
      "session on our side. Is that a limit you enforce, or have we set " +
      "something up wrong at our end?",
    expect: {
      allowedStates: ["ready"],
      humanReviewOnly: true,
      rationale:
        "The recipient can state its own lifetimes but cannot diagnose the " +
        "asker's gateway configuration without seeing it.",
    },
  },
  {
    id: "probe.control.rotation",
    role: "recipient",
    category: "simple_repo_question",
    fixture: "simple-auth",
    incomingMessage:
      "How does refresh token rotation work in your branch? Does it " +
      "invalidate sessions on other devices?",
    expect: {
      allowedStates: ["ready"],
      mustMention: ["session.ts"],
      rationale:
        "Fully answerable from the recipient's own repository. Asking here is " +
        "a false positive, not caution.",
    },
  },
];

/* ========================================================================== *
 * Options
 * ========================================================================== */

interface ProbeOptions {
  runner: "claude" | "codex";
  only: string | null;
  timeoutMs: number;
}

function parseOptions(argv: readonly string[]): ProbeOptions {
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };
  const runner = get("--runner") ?? "claude";
  if (runner !== "claude" && runner !== "codex") {
    throw new Error("--runner must be claude or codex");
  }
  const timeout = get("--timeout");
  return {
    runner,
    only: get("--only"),
    timeoutMs: timeout === null ? 180_000 : Number(timeout),
  };
}

function createRunner(id: "claude" | "codex"): ProtocolRunner {
  return id === "claude" ? new ClaudeCliRunner() : new CodexCliRunner();
}

/* ========================================================================== *
 * Reporting
 * ========================================================================== */

interface ProbeOutcome {
  caseId: string;
  expectedToAsk: boolean;
  parsed: boolean;
  parseFailure: string | null;
  /** Field paths and validator messages. Never the text the model produced. */
  issues: string[];
  state: string | null;
  answered: boolean;
  requestCount: number;
  wellFormed: boolean;
  requests: string[];
  durationMs: number;
}

/**
 * Re-validates each request against the connector's own schema.
 *
 * The output parser already applied it, so this can only ever agree — which is
 * the point. If the two ever disagreed, the ask half of the loop would be
 * accepting something the machine that fulfils it would reject, and the probe
 * should say so rather than report a success the connector would refuse.
 */
function describeRequests(requests: readonly unknown[]): {
  wellFormed: boolean;
  lines: string[];
} {
  const lines: string[] = [];
  let wellFormed = true;
  for (const request of requests) {
    const validated = connectorResourceRequestSchema.safeParse(request);
    if (!validated.success) {
      wellFormed = false;
      lines.push("MALFORMED " + JSON.stringify(request));
      continue;
    }
    const value = validated.data;
    const subject = value.kind === "hint" ? value.hint : value.resourceId;
    lines.push(value.kind + ": " + subject + "  -- because " + value.reason);
  }
  return { wellFormed, lines };
}

/** The ask half of a turn that failed the contract for some other reason. */
function recoverRequests(raw: string): {
  requests: unknown[];
  wellFormed: boolean;
  lines: string[];
} {
  const extracted = extractJsonObject(raw);
  if (!extracted.ok || typeof extracted.value !== "object" || extracted.value === null) {
    return { requests: [], wellFormed: true, lines: [] };
  }
  const field = (extracted.value as Record<string, unknown>)["resourceRequests"];
  if (!Array.isArray(field)) return { requests: [], wellFormed: true, lines: [] };
  const described = describeRequests(field);
  return { requests: field, wellFormed: described.wellFormed, lines: described.lines };
}

async function runProbeCase(
  testCase: RecipientCase,
  config: HarnessConfig,
): Promise<ProbeOutcome> {
  const workspacePath =
    config.workspaceRoot + "/" + testCase.id.replace(/[^a-zA-Z0-9._-]/g, "_");
  await materializeFixture(config.fs, workspacePath, getFixtureRepo(testCase.fixture));

  const prompt = getFormat(config.format).render(buildTurnInput(testCase, config));
  const started = Date.now();
  const result = await config.runner.run({
    prompt,
    workspacePath,
    outputSchema: recipientJsonSchema(),
    timeoutMs: config.timeoutMs,
  });
  const parsed = parseRecipientOutput(result.raw);
  const durationMs = Date.now() - started;
  const expectedToAsk = testCase.id.startsWith("probe.ask.");

  if (!parsed.ok) {
    // A turn can fail the contract for a reason that has nothing to do with
    // asking — an over-long summary, a missing field — and the ask is still
    // the thing being measured. So the requests are recovered from the raw
    // object and validated on their own, and the report says both.
    //
    // The raw text itself is never printed. A failed turn can still quote
    // fixture contents, and this probe has no redaction pass.
    const recovered = recoverRequests(result.raw);
    return {
      caseId: testCase.id,
      expectedToAsk,
      parsed: false,
      parseFailure: parsed.code,
      issues: parsed.issues.map((issue) => issue.path + " — " + issue.message),
      state: null,
      answered: false,
      requestCount: recovered.requests.length,
      wellFormed: recovered.wellFormed,
      requests: recovered.lines,
      durationMs,
    };
  }

  const requests = parsed.value.resourceRequests ?? [];
  const described = describeRequests(requests);
  return {
    caseId: testCase.id,
    expectedToAsk,
    parsed: true,
    parseFailure: null,
    issues: [],
    state: parsed.value.state,
    // Build plan 8 requires a turn to answer from what it can already see even
    // when it asks. A turn that only asked is a regression, not a success.
    answered: parsed.value.sendCandidate !== null,
    requestCount: requests.length,
    wellFormed: described.wellFormed,
    requests: described.lines,
    durationMs,
  };
}

function report(outcomes: readonly ProbeOutcome[]): void {
  const lines: string[] = ["", "CAPABILITY ASK PROBE", ""];
  let failures = 0;
  for (const outcome of outcomes) {
    const asked = outcome.requestCount > 0;
    const correct =
      outcome.parsed && outcome.wellFormed && asked === outcome.expectedToAsk;
    if (!correct) failures += 1;
    lines.push(
      (correct ? "PASS  " : "FAIL  ") +
        outcome.caseId +
        "  (" +
        (outcome.expectedToAsk ? "should ask" : "should not ask") +
        ", " +
        String(Math.round(outcome.durationMs / 1000)) +
        "s)",
    );
    if (!outcome.parsed) {
      lines.push("        unparseable: " + String(outcome.parseFailure));
      for (const issue of outcome.issues) lines.push("          " + issue);
      lines.push(
        "        asked anyway: " +
          String(outcome.requestCount) +
          " requests, wellFormed=" +
          String(outcome.wellFormed),
      );
      for (const request of outcome.requests) lines.push("        " + request);
      continue;
    }
    lines.push(
      "        state=" +
        String(outcome.state) +
        " answered=" +
        String(outcome.answered) +
        " requests=" +
        String(outcome.requestCount) +
        " wellFormed=" +
        String(outcome.wellFormed),
    );
    for (const request of outcome.requests) lines.push("        " + request);
  }
  lines.push(
    "",
    String(outcomes.length - failures) + "/" + String(outcomes.length) + " as expected",
    "",
  );
  process.stdout.write(lines.join("\n") + "\n");
}

/* ========================================================================== *
 * Entry point
 * ========================================================================== */

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!liveEvalEnabled()) {
    process.stderr.write(
      "Refusing to run without " +
        LIVE_EVAL_ENV_VAR +
        "=1.\n" +
        "This probe makes real, billable provider calls. Set the variable\n" +
        "deliberately, and never in CI.\n",
    );
    process.exitCode = 1;
    return;
  }

  const cases = PROBE_CASES.filter(
    (testCase) => options.only === null || testCase.id.includes(options.only),
  );
  if (cases.length === 0) {
    process.stderr.write("No cases matched --only\n");
    process.exitCode = 1;
    return;
  }

  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "telaegent-probe-"));
  const config: HarnessConfig = {
    // P5 and M4 are what the runtime adapter uses in production. A probe run
    // against a different format would answer a question nobody asked.
    format: "P5",
    memory: "M4",
    runner: createRunner(options.runner),
    fs: nodeFileSystemPort,
    workspaceRoot,
    timeoutMs: options.timeoutMs,
    commit: "0000000000000000000000000000000000000000",
    branch: "main",
  };

  const outcomes: ProbeOutcome[] = [];
  for (const testCase of cases) {
    process.stderr.write("running " + testCase.id + "...\n");
    outcomes.push(await runProbeCase(testCase, config));
  }
  report(outcomes);
}

await main();
