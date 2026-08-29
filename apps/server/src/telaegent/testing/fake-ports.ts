/**
 * Test port bundles. Two flavours:
 *
 *   createInMemoryPorts  — memory filesystem and a scripted git, for fast unit
 *                          tests and for the `.env` call-log assertion.
 *   createRealPorts      — real filesystem and real git in a temp directory,
 *                          for the fixture and the end-to-end flow.
 */

import path from "node:path";
import type { SafeAuditHint } from "../contract.js";
import type { GitPort, TelaegentPorts } from "../ports.js";
import { nodeFileSystemPort, nodeGitPort } from "../ports.node.js";
import { createMemoryFileSystem, type MemoryFileSystem } from "./memory-fs.js";
import { createFakeRunner, type FakeRunner, type ScriptedTurn } from "./fake-runners.js";

export interface TestPorts extends TelaegentPorts {
  fs: MemoryFileSystem;
  runner: FakeRunner;
  audit: SafeAuditHint[];
  gitCommands: string[][];
}

/** Records every git argv without running anything. */
export function createRecordingGit(
  responses: Record<string, { stdout?: string; exitCode?: number }> = {},
): { git: GitPort; commands: string[][] } {
  const commands: string[][] = [];
  const git: GitPort = async (args) => {
    commands.push(args);
    const key = args.find((arg) => !arg.startsWith("-")) ?? "";
    const response = responses[key] ?? {};
    return {
      stdout: response.stdout ?? "",
      stderr: "",
      exitCode: response.exitCode ?? 0,
    };
  };
  return { git, commands };
}

export function createInMemoryPorts(options: {
  script?: readonly ScriptedTurn[];
  gitResponses?: Record<string, { stdout?: string; exitCode?: number }>;
  now?: Date;
  temporaryRoot?: string;
} = {}): TestPorts {
  const fs = createMemoryFileSystem();
  const runner = createFakeRunner(options.script ?? []);
  const audit: SafeAuditHint[] = [];
  const { git, commands } = createRecordingGit(options.gitResponses);
  const temporaryRoot = options.temporaryRoot ?? "/tmp/telaegent-test";
  const now = options.now ?? new Date("2026-08-28T02:00:00.000Z");

  return {
    fs,
    runner,
    audit,
    gitCommands: commands,
    git,
    runMiddlewareTurn: (request) => runner.runMiddlewareTurn(request),
    runFixtureTests: async () => ({ passed: true, summary: "Tests 9 passed" }),
    now: () => now,
    temporaryRoot,
    auditHint: (event) => {
      audit.push(event);
    },
  };
}

export interface RealTestPorts extends TelaegentPorts {
  runner: FakeRunner;
  audit: SafeAuditHint[];
}

export function createRealPorts(options: {
  temporaryRoot: string;
  script?: readonly ScriptedTurn[];
  now?: Date;
}): RealTestPorts {
  const runner = createFakeRunner(options.script ?? []);
  const audit: SafeAuditHint[] = [];
  return {
    fs: nodeFileSystemPort,
    git: nodeGitPort,
    runner,
    audit,
    runMiddlewareTurn: (request) => runner.runMiddlewareTurn(request),
    runFixtureTests: async () => ({ passed: true, summary: "Tests 9 passed" }),
    now: () => options.now ?? new Date("2026-08-28T02:00:00.000Z"),
    temporaryRoot: path.join(options.temporaryRoot, "ctx"),
    auditHint: (event) => {
      audit.push(event);
    },
  };
}
