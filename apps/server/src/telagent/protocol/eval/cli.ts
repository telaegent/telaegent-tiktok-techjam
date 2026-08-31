/**
 * EVALUATION CLI — `npm run eval:*`.
 *
 * Deliberately not wired into `npm test`. hien.md §12 requires that normal CI
 * never depends on hundreds of paid live CLI calls, and the enforcement is that
 * this file is only reachable through an explicit script, and that live runners
 * refuse to construct without TELAEGENT_LIVE_EVAL.
 *
 * Usage:
 *   npm run eval:fake                     deterministic smoke run, free
 *   TELAEGENT_LIVE_EVAL=1 npm run eval:claude
 *   TELAEGENT_LIVE_EVAL=1 npm run eval:codex
 *
 * Flags:
 *   --formats P3,P5     default: all five
 *   --memory M4         default: M4
 *   --cases a,b,c       run case ids containing ANY of these substrings
 *   --timeout 120000    per turn
 *   --skip-turns 0      skip this many format/case combinations
 *   --max-turns 100     hard cap for this invocation
 *   --metadata full     full | no-revision | repository-only
 *   --out <dir>         default: ./src/telagent/protocol/eval/results (gitignored)
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

// Reuses the existing real ports rather than adding a second implementation.
// One node:fs adapter in the codebase means one place where the "never called
// on a denied path" guarantee can be broken.
import { nodeFileSystemPort, nodeGitPort } from "../../ports.node.js";
import { PROTOCOL_FORMATS, type MemoryStrategyId, type ProtocolFormatId } from "../contract.js";
import { ALL_CASES } from "../corpus/index.js";
import {
  runCorpus,
  type HarnessConfig,
  type HarnessRunResult,
  type MetadataProfile,
} from "./harness.js";
import { renderReport } from "./report.js";
import { renderReviewSheet, selectForReview } from "./review-sheet.js";
import {
  createRunner,
  liveEvalEnabled,
  type RunnerId,
  type RunnerRequest,
} from "./runner.js";

/* ========================================================================== *
 * Arguments
 * ========================================================================== */

interface Options {
  runner: RunnerId;
  formats: ProtocolFormatId[];
  memory: MemoryStrategyId;
  caseFilters: string[];
  timeoutMs: number;
  skipTurns: number;
  maxTurns: number;
  metadataProfile: MetadataProfile;
  outDir: string;
}

function parseArgs(argv: readonly string[]): Options {
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };

  const runnerArg = (get("--runner") ?? "fake") as RunnerId;
  const formatsArg = get("--formats");

  return {
    runner: runnerArg,
    formats:
      formatsArg === null
        ? [...PROTOCOL_FORMATS]
        : (formatsArg.split(",").map((value) => value.trim()) as ProtocolFormatId[]),
    memory: (get("--memory") ?? "M4") as MemoryStrategyId,
    // Comma-separated so a run can select a whole theme. Case ids are prefixed
    // by concern (`.secret`, `.inject`, `.poison`), so "the safety cases" is
    // expressible without listing thirty-four ids.
    caseFilters: (get("--cases") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
    timeoutMs: Number(get("--timeout") ?? "120000"),
    skipTurns: Number(get("--skip-turns") ?? "0"),
    maxTurns: Number(get("--max-turns") ?? String(Number.MAX_SAFE_INTEGER)),
    metadataProfile: (get("--metadata") ?? "full") as MetadataProfile,
    outDir:
      get("--out") ??
      path.resolve(process.cwd(), "src/telagent/protocol/eval/results"),
  };
}

/* ========================================================================== *
 * Fake responder
 * ========================================================================== */

/**
 * A naive-but-well-formed model, for the free smoke run.
 *
 * Role-aware, because sender and recipient have different schemas and a
 * responder that emits one shape for both fails to parse on exactly half the
 * corpus — which is how this was found: the first smoke run reported 33 parse
 * failures out of 66, a suspiciously round number.
 *
 * It answers everything with a confident `ready`, including the cases that must
 * not produce a sendable candidate. That is deliberate: it models the naive
 * failure mode, so a green smoke run would mean the corpus had stopped
 * catching anything. Expect it to fail the sensitive and adversarial cases.
 *
 * Not a model simulator. Its scores say nothing about any real provider.
 */
function fakeResponder(request: RunnerRequest): string {
  if (request.prompt.role === "recipient") {
    return JSON.stringify({
      state: "ready",
      privateSummary: "Checked the repository and drafted a reply.",
      sendCandidate:
        "Session refresh is handled in src/auth/session.ts; rotation marks the " +
        "previous token consumed so replay is detected.",
      riskFlags: [],
      sourcePaths: ["src/auth/session.ts"],
    });
  }

  return JSON.stringify({
    state: "ready",
    assistantMessage: "Prepared a draft for your review.",
    sendCandidate:
      "Could you describe how the auth service handles session refresh, and " +
      "which function my branch should call?",
    riskFlags: [],
    referencedPaths: ["src/config.ts"],
  });
}

/* ========================================================================== *
 * Main
 * ========================================================================== */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!["full", "no-revision", "repository-only"].includes(options.metadataProfile)) {
    console.error("Invalid --metadata profile: " + options.metadataProfile);
    process.exitCode = 1;
    return;
  }

  if (options.runner !== "fake" && !liveEvalEnabled()) {
    // Fail before doing any work, with the fix in the message.
    console.error(
      "Refusing to run '" +
        options.runner +
        "' without TELAEGENT_LIVE_EVAL=1.\n" +
        "Live evaluation makes real, billable provider calls. Set the variable\n" +
        "deliberately, and never in CI.",
    );
    process.exitCode = 1;
    return;
  }

  const cases =
    options.caseFilters.length === 0
      ? ALL_CASES
      : ALL_CASES.filter((entry) =>
          options.caseFilters.some((filter) => entry.id.includes(filter)),
        );

  if (cases.length === 0) {
    console.error("No cases matched --cases " + options.caseFilters.join(","));
    process.exitCode = 1;
    return;
  }

  // Workspaces go to the OS temp directory, never inside the repository. A
  // fixture tree materialised under the working tree would create nested Git
  // repositories and show up in `git status` for everyone.
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "telaegent-eval-"));
  const fs = nodeFileSystemPort;
  const git = nodeGitPort;

  const results: HarnessRunResult[] = [];
  let turnsToSkip = options.skipTurns;
  let turnsRemaining = options.maxTurns;

  for (const format of options.formats) {
    const skippedInFormat = Math.min(turnsToSkip, cases.length);
    turnsToSkip -= skippedInFormat;
    const selectedCases = cases.slice(
      skippedInFormat,
      skippedInFormat + Math.max(0, turnsRemaining),
    );
    if (selectedCases.length === 0) continue;

    const config: HarnessConfig = {
      format,
      memory: options.memory,
      runner: createRunner(options.runner, { responder: fakeResponder }),
      fs,
      git,
      workspaceRoot: path.join(workspaceRoot, format),
      timeoutMs: options.timeoutMs,
      // Fixed rather than read from a real checkout, so a deterministic run
      // produces byte-identical prompts and a rerun is comparable.
      commit: "0000000000000000000000000000000000000000",
      branch: "main",
      metadataProfile: options.metadataProfile,
    };

    process.stderr.write(
      "running " + format + " (" + String(selectedCases.length) + " cases)...\n",
    );
    results.push(await runCorpus(selectedCases, config));
    turnsRemaining -= selectedCases.length;
    if (turnsRemaining <= 0) break;
  }

  if (results.length === 0) {
    console.error("The requested --skip-turns/--max-turns window selected no cases.");
    process.exitCode = 1;
    return;
  }

  const generatedAt = new Date().toISOString();
  const report = renderReport(results, {
    generatedAt,
    note:
      options.runner === "fake"
        ? "**Fake runner.** These numbers exercise the pipeline and mean nothing " +
          "about any real provider."
        : undefined,
  });

  await mkdir(options.outDir, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, "-");

  const reportPath = path.join(options.outDir, "report-" + options.runner + "-" + stamp + ".md");
  const rawPath = path.join(options.outDir, "raw-" + options.runner + "-" + stamp + ".json");

  await writeFile(reportPath, report, "utf8");
  // Raw results are deliverable H: enough evidence for a teammate to reproduce
  // the conclusions. Gitignored, because a live run's raw output can quote
  // fixture file contents.
  await writeFile(rawPath, JSON.stringify(results, null, 2), "utf8");

  // hien.md §14. Written on every run because the moment to ask three people
  // for twenty minutes is while the numbers are fresh, not a week later when
  // the sheet would have to be regenerated from raw JSON nobody kept.
  const reviewPath = path.join(options.outDir, "review-" + options.runner + "-" + stamp + ".md");
  await writeFile(
    reviewPath,
    renderReviewSheet(selectForReview(results), { generatedAt, reviewerCount: 3 }),
    "utf8",
  );

  console.log(report);
  process.stderr.write(
    "\nreport: " + reportPath + "\nraw:    " + rawPath + "\nreview: " + reviewPath + "\n",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
