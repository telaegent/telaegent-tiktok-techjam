/**
 * PHOENIX FIXTURE — seeds a small, deterministic, network-free TypeScript
 * repository into an Agent workspace, initializes Git, and cuts the demo
 * branch.
 *
 * Three things here exist because of specific findings:
 *
 *   C2  `.env` ships as `env.template` and is written out at init, because the
 *       repository .gitignore would otherwise swallow it and the denial demo
 *       would have no real file to refuse.
 *   C3  Fixture tests run through the injected TestRunnerPort (the host's
 *       Vitest), so the fixture ships zero dependencies and needs no network.
 *   C4  Workspaces are the Starter Kit's own `AGENT_WORKSPACE_ROOT`, which is
 *       already gitignored, so `git init` here never nests a repository inside
 *       the Telaegent repo.
 *
 * The Starter Kit's WorkspaceManager already wrote AGENTS.md, README.md and a
 * .gitignore into the workspace. Those are preserved, never overwritten.
 */

import path from "node:path";
import type { TelaegentPorts } from "./ports.js";
import {
  createBranch,
  createCheckpointCommit,
  currentCommit,
  initRepository,
  type GitResult,
} from "./git-helper.js";

export const PHOENIX_PROJECT_ID = "phoenix";

/** Files that must never be copied verbatim; they are templates or metadata. */
const TEMPLATE_FILES = new Set(["env.template", "gitignore.template"]);

/** Workspace files the Starter Kit owns. Never clobbered by the fixture. */
const PRESERVED_WORKSPACE_FILES = new Set(["AGENTS.md", "README.md"]);

export interface InitializePhoenixInput {
  /** Absolute path of the Agent workspace, from WorkspaceManager. */
  workspacePath: string;
  /** Absolute path of apps/server/fixtures/phoenix. */
  fixtureRoot: string;
  branch: string;
  ownerId: string;
  agentId: string;
}

export interface PhoenixWorkspace {
  workspacePath: string;
  branch: string;
  baseCommit: string;
  filesWritten: number;
  testsPassed: boolean;
  testSummary: string;
}

export type FixtureResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "FIXTURE_FAILED"; safeReason: string };

const fail = (safeReason: string): FixtureResult<never> => ({
  ok: false,
  code: "FIXTURE_FAILED",
  safeReason,
});

/* ========================================================================== *
 * Initialization
 * ========================================================================== */

export async function initializePhoenixWorkspace(
  input: InitializePhoenixInput,
  ports: TelaegentPorts,
): Promise<FixtureResult<PhoenixWorkspace>> {
  const { workspacePath, fixtureRoot, branch } = input;

  if (!path.isAbsolute(workspacePath) || !path.isAbsolute(fixtureRoot)) {
    return fail("Workspace and fixture roots must be absolute paths.");
  }
  if (!(await ports.fs.exists(path.join(fixtureRoot, ".telaegent", "project.json")))) {
    return fail("The Phoenix fixture is missing its project marker.");
  }

  const filesWritten = await copyFixtureTree(fixtureRoot, workspacePath, ports);

  // C2 — the dummy .env, written at init because it cannot be committed.
  const envTemplate = await ports.fs.readFile(path.join(fixtureRoot, "env.template"));
  await ports.fs.writeFile(path.join(workspacePath, ".env"), envTemplate.toString("utf8"));

  await mergeGitignore(fixtureRoot, workspacePath, ports);

  const initialized = await initRepository(workspacePath, ports.git);
  if (!initialized.ok) return fail(initialized.safeReason);

  const base = await createCheckpointCommit(
    workspacePath,
    "Phoenix Web App baseline (Telaegent demo fixture)",
    ports.git,
  );
  if (!base.ok) return fail(base.safeReason);

  const branched = await createBranch(workspacePath, branch, ports.git);
  if (!branched.ok) return fail(branched.safeReason);

  const head = await currentCommit(workspacePath, ports.git);
  if (!head.ok) return fail(head.safeReason);

  const tests = await ports.runFixtureTests(workspacePath);

  ports.auditHint({
    eventType: "phoenix_workspace_initialized",
    outcome: tests.passed ? "recorded" : "failed",
    actorOwnerId: input.ownerId,
    actorAgentId: input.agentId,
    safePayload: {
      branch,
      baseCommit: head.value.slice(0, 7),
      filesWritten,
      testsPassed: tests.passed,
    },
    correlationId: "fixture:" + input.agentId,
  });

  if (!tests.passed) {
    return fail("The Phoenix fixture tests did not pass after initialization.");
  }

  return {
    ok: true,
    value: {
      workspacePath,
      branch,
      baseCommit: head.value,
      filesWritten,
      testsPassed: true,
      testSummary: tests.summary,
    },
  };
}

async function copyFixtureTree(
  fixtureRoot: string,
  workspacePath: string,
  ports: TelaegentPorts,
  relative = "",
): Promise<number> {
  const sourceDir = path.join(fixtureRoot, relative);
  const entries = (await ports.fs.readDir(sourceDir)).sort();
  let written = 0;

  for (const entry of entries) {
    const childRelative = relative ? path.posix.join(relative, entry) : entry;
    if (TEMPLATE_FILES.has(childRelative)) continue;
    if (PRESERVED_WORKSPACE_FILES.has(childRelative)) continue;

    const source = path.join(fixtureRoot, childRelative);
    const stats = await ports.fs.lstat(source);

    if (stats.isDirectory) {
      await ports.fs.mkdir(path.join(workspacePath, childRelative));
      written += await copyFixtureTree(fixtureRoot, workspacePath, ports, childRelative);
      continue;
    }
    if (!stats.isFile) continue; // never copy links or devices

    const content = await ports.fs.readFile(source);
    const destination = path.join(workspacePath, childRelative);
    await ports.fs.mkdir(path.dirname(destination));
    await ports.fs.writeFile(destination, content.toString("utf8"));
    written += 1;
  }
  return written;
}

/** Adds the fixture's ignore lines without dropping the Starter Kit's. */
async function mergeGitignore(
  fixtureRoot: string,
  workspacePath: string,
  ports: TelaegentPorts,
): Promise<void> {
  const target = path.join(workspacePath, ".gitignore");
  const template = (
    await ports.fs.readFile(path.join(fixtureRoot, "gitignore.template"))
  ).toString("utf8");

  let existing = "";
  if (await ports.fs.exists(target)) {
    existing = (await ports.fs.readFile(target)).toString("utf8");
  }
  const lines = new Set(
    [...existing.split("\n"), ...template.split("\n")]
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  await ports.fs.writeFile(target, [...lines].sort().join("\n") + "\n");
}

/* ========================================================================== *
 * Bob's contract change (demo stage 12)
 * ========================================================================== */

/** Files Bob's Session-contract change touches. All Bob-owned by the agreement. */
export const CONTRACT_CHANGE_PATHS = [
  "src/auth/session-repository.ts",
  "src/auth/fake-session-repository.ts",
  "src/auth/redis-session-repository.ts",
  "src/models/session.ts",
  "tests/auth/session.test.ts",
] as const;

/**
 * Makes `deviceId` required on SessionRepository.create — the change that makes
 * Alice's OAuth callback plan stale.
 *
 * Runs only inside Bob's workspace, and touches only Bob-owned paths, so
 * validateChangedPaths() accepts the resulting diff.
 */
export async function applyBobContractChange(
  workspacePath: string,
  ports: TelaegentPorts,
): Promise<FixtureResult<{ changedFiles: string[]; commit: string }>> {
  const edits: Array<[string, Array<[string, string]>]> = [
    [
      "src/auth/session-repository.ts",
      [
        [
          "  /** Optional today. A later change makes this required. */\n  deviceId?: string;",
          "  /** Required since the device-binding change. Callers must supply it. */\n  deviceId: string;",
        ],
        [
          "export const SESSION_TTL_SECONDS = 1800;",
          "export const SESSION_TTL_SECONDS = 1800;\n\n/** Guards the contract at runtime so a missing device is a failure, not a silent gap. */\nexport function assertDeviceId(input: CreateSessionInput): string {\n  if (typeof input.deviceId !== \"string\" || input.deviceId.length === 0) {\n    throw new Error(\"SessionRepository.create requires deviceId\");\n  }\n  return input.deviceId;\n}",
        ],
      ],
    ],
    [
      "src/models/session.ts",
      [
        [
          "  /**\n   * Device the session was created from.\n   *\n   * Optional today so existing clients keep working. See\n   * docs/architecture/auth.md — \"Device binding\".\n   */\n  deviceId?: string;",
          "  /** Device the session was created from. Required since device binding. */\n  deviceId: string;",
        ],
      ],
    ],
    [
      "src/auth/fake-session-repository.ts",
      [
        [
          'import {\n  SESSION_TTL_SECONDS,\n  type CreateSessionInput,\n  type SessionRepository,\n} from "./session-repository";',
          'import {\n  assertDeviceId,\n  SESSION_TTL_SECONDS,\n  type CreateSessionInput,\n  type SessionRepository,\n} from "./session-repository";',
        ],
        [
          "    const session: Session = {\n      id: \"sess_\" + this.counter,\n      userId: input.userId,\n      createdAt: issuedAt.toISOString(),\n      expiresAt: new Date(issuedAt.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),\n    };\n    if (input.deviceId !== undefined) {\n      session.deviceId = input.deviceId;\n    }",
          "    const session: Session = {\n      id: \"sess_\" + this.counter,\n      userId: input.userId,\n      deviceId: assertDeviceId(input),\n      createdAt: issuedAt.toISOString(),\n      expiresAt: new Date(issuedAt.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),\n    };",
        ],
      ],
    ],
    [
      "src/auth/redis-session-repository.ts",
      [
        [
          'import {\n  SESSION_TTL_SECONDS,\n  sessionKey,\n  type CreateSessionInput,\n  type SessionRepository,\n} from "./session-repository";',
          'import {\n  assertDeviceId,\n  SESSION_TTL_SECONDS,\n  sessionKey,\n  type CreateSessionInput,\n  type SessionRepository,\n} from "./session-repository";',
        ],
        [
          "    const session: Session = {\n      id: this.newId(),\n      userId: input.userId,\n      createdAt: issuedAt.toISOString(),\n      expiresAt: new Date(issuedAt.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),\n    };\n    if (input.deviceId !== undefined) {\n      session.deviceId = input.deviceId;\n    }",
          "    const session: Session = {\n      id: this.newId(),\n      userId: input.userId,\n      deviceId: assertDeviceId(input),\n      createdAt: issuedAt.toISOString(),\n      expiresAt: new Date(issuedAt.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),\n    };",
        ],
      ],
    ],
    [
      "tests/auth/session.test.ts",
      [
        [
          '    const session = await service.startSession("user_1");\n\n    expect(new Date(session.expiresAt).getTime()',
          '    const session = await service.startSession("user_1", "device-abc");\n\n    expect(new Date(session.expiresAt).getTime()',
        ],
        [
          '  it("omits the device when none is supplied", async () => {\n    const service = new SessionService(new FakeSessionRepository());\n    const session = await service.startSession("user_1");\n    expect(session.deviceId).toBeUndefined();\n  });',
          '  it("refuses to create a session without a device", async () => {\n    const service = new SessionService(new FakeSessionRepository());\n    await expect(service.startSession("user_1")).rejects.toThrow(/requires deviceId/);\n  });',
        ],
        [
          '    const session = await repository.create({ userId: "user_1" });\n\n    expect(await service.resolve(session.id)).toBeNull();',
          '    const session = await repository.create({ userId: "user_1", deviceId: "d1" });\n\n    expect(await service.resolve(session.id)).toBeNull();',
        ],
        [
          '    const session = await repository.create({ userId: "user_1" });\n\n    await service.endSession(session.id);',
          '    const session = await repository.create({ userId: "user_1", deviceId: "d1" });\n\n    await service.endSession(session.id);',
        ],
      ],
    ],
  ];

  for (const [relativePath, replacements] of edits) {
    const absolute = path.join(workspacePath, relativePath);
    if (!(await ports.fs.exists(absolute))) {
      return fail("Fixture file missing before contract change: " + relativePath);
    }
    // Git checks the fixture out with CRLF on Windows, and every anchor below is
    // written with LF. Matching against the raw bytes silently finds nothing and
    // reports "anchor not found" on the one machine that matters — the demo
    // machine. Normalize before matching, and write LF back.
    let content = toLf((await ports.fs.readFile(absolute)).toString("utf8"));
    for (const [from, to] of replacements) {
      const anchor = toLf(from);
      if (!content.includes(anchor)) {
        return fail("Contract change anchor not found in " + relativePath);
      }
      content = content.replace(anchor, toLf(to));
    }
    await ports.fs.writeFile(absolute, content);
  }

  const committed = await createCheckpointCommit(
    workspacePath,
    "SessionRepository.create now requires deviceId",
    ports.git,
  );
  if (!committed.ok) return fail(committed.safeReason);

  return {
    ok: true,
    value: { changedFiles: committed.value.changedFiles, commit: committed.value.commit },
  };
}

/* ========================================================================== *
 * Reset
 * ========================================================================== */

/**
 * Removes a Phoenix workspace. Refuses anything that is not, provably, a
 * Phoenix workspace directly beneath the configured workspace root — this is
 * the only delete workstream #6 performs outside the temporary context root.
 */
export async function resetPhoenixWorkspace(
  workspacePath: string,
  workspaceRoot: string,
  ports: TelaegentPorts,
): Promise<FixtureResult<null>> {
  if (!path.isAbsolute(workspacePath) || !path.isAbsolute(workspaceRoot)) {
    return fail("Reset requires absolute paths.");
  }
  if (path.dirname(workspacePath) !== path.resolve(workspaceRoot)) {
    return fail("Reset target is not directly inside the Agent workspace root.");
  }
  if (workspacePath === path.resolve(workspaceRoot)) {
    return fail("Reset refuses to delete the workspace root itself.");
  }
  const marker = path.join(workspacePath, ".telaegent", "project.json");
  if (!(await ports.fs.exists(marker))) {
    return fail("Reset target does not carry the Phoenix project marker.");
  }
  const raw = (await ports.fs.readFile(marker)).toString("utf8");
  let projectId: unknown;
  try {
    projectId = (JSON.parse(raw) as { projectId?: unknown }).projectId;
  } catch {
    return fail("Reset target has an unreadable project marker.");
  }
  if (projectId !== PHOENIX_PROJECT_ID) {
    return fail("Reset target belongs to a different project.");
  }

  await ports.fs.removeTree(workspacePath);
  return { ok: true, value: null };
}

/**
 * Normalizes any line ending to LF before an anchor match: CRLF, a lone CR, and
 * the CR-CR-LF a naive conversion produces on a file that was already CRLF.
 * See applyBobContractChange.
 */
function toLf(value: string): string {
  return value.replace(/\r+\n/g, "\n").replace(/\r/g, "\n");
}

export function phoenixFixtureRoot(serverPackageRoot: string): string {
  return path.join(serverPackageRoot, "fixtures", "phoenix");
}
