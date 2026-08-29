/**
 * GIT EVIDENCE — safe, read-mostly Git for checkpoints and ownership proof.
 *
 * Every call goes through the injected GitPort, which is execFile with an
 * argument array. No branch name, path, or commit message is ever concatenated
 * into a shell command.
 *
 * This module deliberately has no `reset --hard`, no `push`, no `merge`, no
 * remote mutation and no broad delete. `git-helper.test.ts` asserts that by
 * inspecting every command this module can emit.
 */

import path from "node:path";
import type { ActiveAgreement, DenialCode } from "./contract.js";
import type { NormalizedRule, PolicyResult } from "./context-policy.js";
import {
  matchesRules,
  normalizeCandidatePath,
  normalizeRuleList,
} from "./context-policy.js";
import type { GitPort } from "./ports.js";

/** Demo-only identity. Never the operator's real git config. */
export const DEMO_GIT_IDENTITY = {
  name: "Telaegent Demo",
  email: "demo@telaegent.local",
} as const;

const identityArgs = [
  "-c",
  "user.name=" + DEMO_GIT_IDENTITY.name,
  "-c",
  "user.email=" + DEMO_GIT_IDENTITY.email,
  "-c",
  "commit.gpgsign=false",
];

export interface GitFailure {
  ok: false;
  code: "GIT_FAILED";
  safeReason: string;
}

export type GitResult<T> = { ok: true; value: T } | GitFailure;

const gitFail = (safeReason: string): GitFailure => ({
  ok: false,
  code: "GIT_FAILED",
  safeReason,
});

/**
 * Git's stderr can contain absolute local paths. Callers get a short, safe
 * reason instead.
 */
function safeGitReason(command: string, exitCode: number): string {
  return "git " + command + " failed (exit " + exitCode + ")";
}

/* ========================================================================== *
 * Read operations
 * ========================================================================== */

export async function currentCommit(cwd: string, git: GitPort): Promise<GitResult<string>> {
  const result = await git(["rev-parse", "HEAD"], cwd);
  if (result.exitCode !== 0) return gitFail(safeGitReason("rev-parse", result.exitCode));
  return { ok: true, value: result.stdout.trim() };
}

export async function currentBranch(cwd: string, git: GitPort): Promise<GitResult<string>> {
  const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (result.exitCode !== 0) return gitFail(safeGitReason("rev-parse", result.exitCode));
  return { ok: true, value: result.stdout.trim() };
}

/**
 * Changed paths from `git status --porcelain -z`. NUL-delimited so filenames
 * containing spaces or quotes cannot be mis-split.
 *
 * This is the AUTHORITATIVE source for ownership validation. The provider's
 * self-reported changedFiles is a cross-check only (finding C9).
 */
export async function statusChangedPaths(
  cwd: string,
  git: GitPort,
): Promise<GitResult<string[]>> {
  const result = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
  if (result.exitCode !== 0) return gitFail(safeGitReason("status", result.exitCode));
  return { ok: true, value: parsePorcelainZ(result.stdout) };
}

export function parsePorcelainZ(stdout: string): string[] {
  const paths: string[] = [];
  const records = stdout.split("\0").filter((record) => record.length > 0);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    const value = record.slice(3);
    // A rename record is followed by its original path in the next chunk.
    if (status.includes("R") || status.includes("C")) index += 1;
    paths.push(toPosix(value));
  }
  return [...new Set(paths)].sort();
}

export async function diffNameOnlyFrom(
  cwd: string,
  fromRef: string,
  git: GitPort,
): Promise<GitResult<string[]>> {
  const result = await git(["diff", "--name-only", "-z", fromRef, "--"], cwd);
  if (result.exitCode !== 0) return gitFail(safeGitReason("diff", result.exitCode));
  const paths = result.stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map(toPosix);
  return { ok: true, value: [...new Set(paths)].sort() };
}

/* ========================================================================== *
 * Write operations — creation only, never destruction
 * ========================================================================== */

export async function initRepository(cwd: string, git: GitPort): Promise<GitResult<null>> {
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.name", DEMO_GIT_IDENTITY.name],
    ["config", "user.email", DEMO_GIT_IDENTITY.email],
    ["config", "commit.gpgsign", "false"],
  ]) {
    const result = await git(args, cwd);
    if (result.exitCode !== 0) {
      return gitFail(safeGitReason(args[0] ?? "init", result.exitCode));
    }
  }
  return { ok: true, value: null };
}

export async function createCheckpointCommit(
  cwd: string,
  message: string,
  git: GitPort,
): Promise<GitResult<{ commit: string; changedFiles: string[] }>> {
  const changed = await statusChangedPaths(cwd, git);
  if (!changed.ok) return changed;
  if (changed.value.length === 0) {
    const head = await currentCommit(cwd, git);
    if (!head.ok) return head;
    return { ok: true, value: { commit: head.value, changedFiles: [] } };
  }

  const staged = await git(["add", "--all", "--"], cwd);
  if (staged.exitCode !== 0) return gitFail(safeGitReason("add", staged.exitCode));

  // The message is one argv element. Nothing in it is interpreted.
  const committed = await git([...identityArgs, "commit", "-m", message], cwd);
  if (committed.exitCode !== 0) return gitFail(safeGitReason("commit", committed.exitCode));

  const head = await currentCommit(cwd, git);
  if (!head.ok) return head;
  return { ok: true, value: { commit: head.value, changedFiles: changed.value } };
}

export async function createBranch(
  cwd: string,
  branch: string,
  git: GitPort,
): Promise<GitResult<null>> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]{0,80}$/.test(branch) || branch.includes("..")) {
    return gitFail("The branch name is not a safe demo branch name.");
  }
  const result = await git(["checkout", "-B", branch], cwd);
  if (result.exitCode !== 0) return gitFail(safeGitReason("checkout", result.exitCode));
  return { ok: true, value: null };
}

/* ========================================================================== *
 * Ownership validation
 * ========================================================================== */

export interface OwnershipViolation {
  ok: false;
  code: Extract<DenialCode, "OWNERSHIP_VIOLATION">;
  safeReason: string;
  /** Relative paths only. */
  offendingPaths: string[];
}

export interface OwnershipOk {
  ok: true;
  value: { changedFiles: string[] };
}

export type OwnershipResult = OwnershipOk | OwnershipViolation;

export interface OwnershipInput {
  changedPaths: readonly string[];
  agreement: ActiveAgreement;
  actorOwnerId: string;
  /**
   * Shared-contract paths this actor has already published a dependency change
   * for. plan.md §5: Bob may change the Session contract, but only after
   * publishing it.
   */
  publishedContractPaths?: readonly string[] | undefined;
}

/**
 * Ownership comes from the ACTIVE AGREEMENT, never from constants in this file
 * (finding C10). If Duy's agreement engine and this gate ever disagree, the
 * bug is one shared record, not two opinions.
 */
export function validateChangedPaths(input: OwnershipInput): OwnershipResult {
  const { agreement, actorOwnerId } = input;

  if (agreement.state !== "active") {
    return {
      ok: false,
      code: "OWNERSHIP_VIOLATION",
      safeReason: "No active ownership agreement covers this change.",
      offendingPaths: [],
    };
  }

  const owned = agreement.ownership.find((rule) => rule.ownerId === actorOwnerId);
  if (!owned) {
    return {
      ok: false,
      code: "OWNERSHIP_VIOLATION",
      safeReason: "The active agreement assigns this owner no files.",
      offendingPaths: [],
    };
  }

  const normalizedRules = normalizeRuleList(owned.files);
  const rules: NormalizedRule[] = normalizedRules.ok ? normalizedRules.value : [];

  const publishedRules = normalizeRuleList([...(input.publishedContractPaths ?? [])]);
  const published: NormalizedRule[] = publishedRules.ok ? publishedRules.value : [];

  const accepted: string[] = [];
  const offending: string[] = [];

  for (const raw of input.changedPaths) {
    const normalized = normalizeCandidatePath(raw);
    if (!normalized.ok) {
      offending.push(raw);
      continue;
    }
    if (matchesRules(normalized.value, rules) || exactMatch(normalized.value, owned.files)) {
      accepted.push(normalized.value);
      continue;
    }
    if (matchesRules(normalized.value, published) || exactMatch(normalized.value, [
      ...(input.publishedContractPaths ?? []),
    ])) {
      accepted.push(normalized.value);
      continue;
    }
    offending.push(normalized.value);
  }

  if (offending.length > 0) {
    return {
      ok: false,
      code: "OWNERSHIP_VIOLATION",
      safeReason:
        "The diff touches " +
        offending.length +
        " path(s) outside this owner's scope in the active agreement.",
      offendingPaths: offending.sort(),
    };
  }

  return { ok: true, value: { changedFiles: accepted.sort() } };
}

function exactMatch(candidate: string, rules: readonly string[]): boolean {
  return rules.some((rule) => toPosix(rule) === candidate);
}

/**
 * Cross-check between the provider's self-reported changed files and Git's
 * answer. Git wins; a mismatch is an audit fact, not a failure (finding C9).
 */
export function compareReportedChanges(
  gitPaths: readonly string[],
  reportedPaths: readonly string[],
): { agreed: boolean; missingFromReport: string[]; notInGit: string[] } {
  const gitSet = new Set(gitPaths.map(toPosix));
  const reportedSet = new Set(reportedPaths.map(toPosix));
  const missingFromReport = [...gitSet].filter((entry) => !reportedSet.has(entry)).sort();
  const notInGit = [...reportedSet].filter((entry) => !gitSet.has(entry)).sort();
  return {
    agreed: missingFromReport.length === 0 && notInGit.length === 0,
    missingFromReport,
    notInGit,
  };
}

export function toPosix(candidate: string): string {
  return candidate.replace(/\\/g, "/").replace(/^\.\//, "").split(path.sep).join("/");
}
