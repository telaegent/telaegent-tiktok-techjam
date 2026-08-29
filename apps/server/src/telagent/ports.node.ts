/**
 * Real implementations of the #6 ports. This is the only file in workstream #6
 * that imports node:fs or node:child_process — everything else receives them
 * through TelagentPorts (findings C6, C7).
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  FileSystemPort,
  GitPort,
  PortFileStat,
  TestRunnerPort,
} from "./ports.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
const FIXTURE_TEST_TIMEOUT_MS = 120_000;

export const nodeFileSystemPort: FileSystemPort = {
  async lstat(absolutePath: string): Promise<PortFileStat> {
    const stats = await lstat(absolutePath);
    return {
      size: stats.size,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
    };
  },
  realpath: (absolutePath) => realpath(absolutePath),
  readDir: (absolutePath) => readdir(absolutePath),
  readFile: (absolutePath) => readFile(absolutePath),
  copyFile: (from, to) => copyFile(from, to),
  async mkdir(absolutePath) {
    await mkdir(absolutePath, { recursive: true });
  },
  mkdtemp: (prefix) => mkdtemp(prefix),
  async writeFile(absolutePath, data) {
    await writeFile(absolutePath, data, "utf8");
  },
  async removeTree(absolutePath) {
    if (!path.isAbsolute(absolutePath)) {
      throw new Error("removeTree requires an absolute path");
    }
    await rm(absolutePath, { recursive: true, force: true });
  },
  async exists(absolutePath) {
    try {
      await lstat(absolutePath);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Git through execFile with an argument array. There is no code path here that
 * builds a command string, so no branch name, path, or commit message can be
 * shell-interpreted.
 */
export const nodeGitPort: GitPort = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
};

/**
 * Runs the fixture's tests with THIS package's Vitest binary against the copied
 * workspace, so the fixture ships no dependencies and needs no network
 * (finding C3).
 */
export function createNodeTestRunnerPort(serverPackageRoot: string): TestRunnerPort {
  return async (workspacePath: string) => {
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          // npm workspaces hoist devDependencies to the repository root, so the
          // binary is resolved rather than assumed to sit under apps/server.
          resolveVitestBin(serverPackageRoot),
          "run",
          "--config",
          path.join(serverPackageRoot, "vitest.fixture.config.ts"),
        ],
        {
          cwd: serverPackageRoot,
          timeout: FIXTURE_TEST_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
          encoding: "utf8",
          env: {
            ...process.env,
            VITEST_FIXTURE_ROOT: workspacePath,
            CI: "1",
            // Colour codes land between "Tests" and the counts and break any
            // parse of the summary line. Belt and braces with the ANSI strip
            // in summarizeVitest below, because a parent process that exports
            // FORCE_COLOR wins over CI.
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
        },
      );
      return { passed: true, summary: summarizeVitest(stdout) };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return {
        passed: false,
        summary: summarizeVitest(failure.stdout ?? failure.stderr ?? "failed"),
      };
    }
  };
}

/**
 * Resolves Vitest's CLI wherever npm hoisted it. Never guesses a path — a wrong
 * guess turns "the fixture tests failed" into a message the demo cannot debug.
 */
function resolveVitestBin(serverPackageRoot: string): string {
  const require = createRequire(path.join(serverPackageRoot, "package.json"));
  const packageJsonPath = require.resolve("vitest/package.json");
  return path.join(path.dirname(packageJsonPath), "vitest.mjs");
}

/**
 * Keeps only the counts line; provider/tool paths never reach the store.
 *
 * The output is stripped of ANSI escapes first. Without that, a colour-enabled
 * child writes `Tests \x1b[22m \x1b[1m\x1b[32m9 passed` and every reasonable
 * regex misses it — which is how a passing fixture run reports "no test
 * summary" on one machine and the right answer on another.
 */
function summarizeVitest(output: string): string {
  const plain = output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const line = plain
    .split("\n")
    .reverse()
    .find((candidate) => /^\s*Tests\s+\d/.test(candidate));
  return (line ?? "no test summary").trim().replace(/\s+/g, " ").slice(0, 200);
}
