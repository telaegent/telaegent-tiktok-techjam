/**
 * EVALUATION HARNESS — runs the corpus against a format, a memory strategy and
 * a runner, and produces scored results.
 *
 * This is the callable harness phuong.md §23 item 11 asks for: one function
 * that takes a configuration and returns numbers, usable from a test, from a
 * script, or from a future CI job that runs live evaluation on a schedule.
 *
 * The design constraint is reproducibility. Everything that could vary between
 * runs is a parameter: the clock, the workspace root, the runner. Nothing here
 * reads the current time or the filesystem directly, so replaying a
 * configuration produces the same prompts — which is what makes a difference in
 * scores attributable to the thing that changed.
 */

import type { FileSystemPort, GitPort } from "../../ports.js";
import {
  type MemoryStrategyId,
  type ProjectFacts,
  type ProtocolFormatId,
  type ProtocolTurnInput,
  type RecipientTurnInput,
  type SenderTurnInput,
} from "../contract.js";
import type { ProtocolCase } from "../corpus/types.js";
import { getFormat } from "../formats.js";
import { guardTurn, type GuardVerdict } from "../guards.js";
import { getMemoryStrategy } from "../memory.js";
import { parseRecipientOutput, parseSenderOutput } from "../schemas.js";
import { recipientJsonSchema, senderJsonSchema } from "../schemas.js";
import { scanOutput, type LeakageReport } from "../evaluators/leakage.js";
import { scoreCase, type CaseScore } from "../evaluators/score.js";
import { getFixtureRepo } from "../fixtures/repos.js";
import { materializeFixture } from "../fixtures/materialize.js";
import type { ProtocolRunner } from "./runner.js";

/* ========================================================================== *
 * Configuration
 * ========================================================================== */

export interface HarnessConfig {
  format: ProtocolFormatId;
  memory: MemoryStrategyId;
  runner: ProtocolRunner;
  fs: FileSystemPort;
  /** Provided only when fixtures need to be real Git repositories. */
  git?: GitPort | undefined;
  /** Absolute directory the per-case workspaces are created under. */
  workspaceRoot: string;
  /** Per-turn ceiling. */
  timeoutMs: number;
  /**
   * Commit reported in project facts.
   *
   * A parameter rather than a `git rev-parse`, so deterministic runs produce
   * byte-identical prompts. Live runs pass the real value from
   * `initFixtureGit`.
   */
  commit: string;
  branch: string;
}

/* ========================================================================== *
 * Results
 * ========================================================================== */

export interface CaseRunResult {
  caseId: string;
  format: ProtocolFormatId;
  memory: MemoryStrategyId;
  runnerId: string;
  /** Prompt size, for the context-efficiency column (hien.md §5). */
  promptChars: number;
  approximateTokens: number;
  durationMs: number;
  /** How the output failed to parse, when it did. */
  parseFailure?: string | undefined;
  score: CaseScore;
  leakage: LeakageReport;
  guard: GuardVerdict | null;
  /**
   * The state after deterministic guards, which is what the product would
   * actually show. Distinct from the model's claimed state, and the gap between
   * them is itself a finding.
   */
  effectiveState: string;
}

export interface HarnessRunResult {
  format: ProtocolFormatId;
  memory: MemoryStrategyId;
  runnerId: string;
  cases: CaseRunResult[];
  startedAt: string;
  finishedAt: string;
}

/* ========================================================================== *
 * Turn construction
 * ========================================================================== */

const OWNER_NAME = "Justin";
const COLLABORATOR_NAME = "Phuong";

function factsFor(testCase: ProtocolCase, config: HarnessConfig): ProjectFacts {
  return {
    repositoryFullName: "telaegent/" + testCase.fixture,
    githubRepositoryId: "fixture-" + testCase.fixture,
    branch: config.branch,
    commit: config.commit,
    ownerName: OWNER_NAME,
    collaboratorName: COLLABORATOR_NAME,
  };
}

/**
 * Builds the turn input, applying the memory strategy.
 *
 * The memory strategy is applied here rather than inside the format renderer on
 * purpose: format and memory are independent variables, and mixing them would
 * make it impossible to say whether P5 beat P3 because of its layout or because
 * of the history it happened to include.
 */
export function buildTurnInput(
  testCase: ProtocolCase,
  config: HarnessConfig,
): ProtocolTurnInput {
  const facts = factsFor(testCase, config);
  const strategy = getMemoryStrategy(config.memory);
  const projectFacts = [
    "repository " + facts.repositoryFullName,
    "branch " + facts.branch,
  ];
  const selection = strategy.select(testCase.sharedHistory ?? [], projectFacts);

  const shared = {
    facts,
    privateTurns: testCase.privateTurns ?? [],
    sharedHistory: selection.turns,
    projectSummary: selection.summary,
  };

  if (testCase.role === "sender") {
    const input: SenderTurnInput = {
      role: "sender",
      ownerInput: testCase.ownerInput,
      ...shared,
    };
    return input;
  }

  const input: RecipientTurnInput = {
    role: "recipient",
    incomingMessage: testCase.incomingMessage,
    ...shared,
  };
  return input;
}

/* ========================================================================== *
 * Single case
 * ========================================================================== */

export async function runCase(
  testCase: ProtocolCase,
  config: HarnessConfig,
): Promise<CaseRunResult> {
  const workspacePath = config.workspaceRoot + "/" + testCase.id.replace(/[^a-zA-Z0-9._-]/g, "_");
  await materializeFixture(config.fs, workspacePath, getFixtureRepo(testCase.fixture));

  const input = buildTurnInput(testCase, config);
  const prompt = getFormat(config.format).render(input);

  const result = await config.runner.run({
    prompt,
    workspacePath,
    outputSchema: testCase.role === "sender" ? senderJsonSchema() : recipientJsonSchema(),
    timeoutMs: config.timeoutMs,
  });

  const parsed =
    testCase.role === "sender"
      ? parseSenderOutput(result.raw)
      : parseRecipientOutput(result.raw);

  // Cross-project detection applies only when the conversation is scoped to
  // repo-a. In a repo-b conversation that sentinel is ordinary local content,
  // and flagging it would be a false positive in the one place a false positive
  // is most expensive.
  const leakage = scanOutput(
    parsed.ok ? (parsed.value as unknown as Record<string, unknown>) : { raw: result.raw },
    {
      forbiddenStrings: testCase.expect.mustNotContain ?? [],
      crossProjectScoped: testCase.fixture === "repo-a",
    },
  );

  const guard = parsed.ok ? guardTurn(parsed.value) : null;

  const score = scoreCase({
    caseId: testCase.id,
    expectation: testCase.expect,
    parsed: parsed.ok
      ? {
          state: parsed.value.state,
          sendCandidate: parsed.value.sendCandidate,
          riskFlags: parsed.value.riskFlags,
          allText: collectText(parsed.value as unknown as Record<string, unknown>),
        }
      : null,
    guard: guard?.verdict ?? null,
    leakage,
    clarificationTurnsUsed: testCase.privateTurns?.length ?? 0,
  });

  return {
    caseId: testCase.id,
    format: config.format,
    memory: config.memory,
    runnerId: config.runner.id,
    promptChars: prompt.characterCount,
    approximateTokens: prompt.approximateTokens,
    durationMs: result.durationMs,
    parseFailure: parsed.ok
      ? undefined
      : parsed.code + ": " + parsed.issues.map((issue) => issue.path).join(", "),
    score,
    leakage,
    guard: guard?.verdict ?? null,
    effectiveState: guard?.effectiveState ?? "unparsed",
  };
}

/**
 * Flattens every string in an output object.
 *
 * Scoring assertions apply to the whole output, not only the send candidate:
 * `mustNotContain` must hold for the private fields too, because a secret in a
 * private summary is still stored and still rendered.
 */
function collectText(value: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 100)) walk(item, depth + 1);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const item of Object.values(node as Record<string, unknown>)) {
        walk(item, depth + 1);
      }
    }
  };
  walk(value, 0);
  return parts.join("\n");
}

/* ========================================================================== *
 * Full run
 * ========================================================================== */

/**
 * Runs the corpus sequentially.
 *
 * Sequential on purpose. Concurrency against a live provider hits rate limits
 * and makes the latency column meaningless, and the fake runner is fast enough
 * that parallelism would buy nothing in CI. If a live run needs to be faster,
 * the right lever is running fewer formats, not more processes at once.
 */
export async function runCorpus(
  cases: readonly ProtocolCase[],
  config: HarnessConfig,
): Promise<HarnessRunResult> {
  const startedAt = new Date().toISOString();
  const results: CaseRunResult[] = [];

  for (const testCase of cases) {
    results.push(await runCase(testCase, config));
  }

  return {
    format: config.format,
    memory: config.memory,
    runnerId: config.runner.id,
    cases: results,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
