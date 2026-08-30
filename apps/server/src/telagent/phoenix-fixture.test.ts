import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyBobContractChange,
  initializePhoenixWorkspace,
  phoenixFixtureRoot,
  resetPhoenixWorkspace,
  CONTRACT_CHANGE_PATHS,
} from "./phoenix-fixture.js";
import { statusChangedPaths, validateChangedPaths } from "./git-helper.js";
import { enumerateApprovedSources, normalizeRuleSet } from "./context-policy.js";
import { CONTEXT_LIMITS } from "./contract.js";
import { nodeFileSystemPort, nodeGitPort } from "./ports.node.js";
import type { TelagentPorts } from "./ports.js";
import type { ActiveAgreement } from "./contract.js";

const SERVER_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE_ROOT = phoenixFixtureRoot(SERVER_ROOT);

let workspaceRoot: string;
let audit: Array<Record<string, unknown>>;
let ports: TelagentPorts;

/**
 * Real filesystem and real Git. The fixture test runner is stubbed so this
 * suite stays fast; `runs the fixture's own tests` below uses the real one.
 */
const makePorts = (temporaryRoot: string): TelagentPorts => ({
  runMiddlewareTurn: async () => {
    throw new Error("no provider run expected in fixture tests");
  },
  fs: nodeFileSystemPort,
  git: nodeGitPort,
  runFixtureTests: async () => ({ passed: true, summary: "stubbed" }),
  now: () => new Date("2026-08-28T02:00:00.000Z"),
  temporaryRoot,
  auditHint: (event) => {
    audit.push(event as unknown as Record<string, unknown>);
  },
});

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "telagent-ws-"));
  audit = [];
  ports = makePorts(path.join(workspaceRoot, ".tmp"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

const initialize = async (agentId: string, branch: string) => {
  const workspacePath = path.join(workspaceRoot, agentId);
  await nodeFileSystemPort.mkdir(workspacePath);
  // The Starter Kit's WorkspaceManager writes these before Telagent runs.
  await nodeFileSystemPort.writeFile(
    path.join(workspacePath, "AGENTS.md"),
    "# Platform-managed Agent instructions\n\nDo not overwrite me.\n",
  );
  await nodeFileSystemPort.writeFile(
    path.join(workspacePath, ".gitignore"),
    ".codex/\nnode_modules/\n",
  );
  return initializePhoenixWorkspace(
    {
      workspacePath,
      fixtureRoot: FIXTURE_ROOT,
      branch,
      ownerId: agentId === "phoenix-alice" ? "alice" : "bob",
      agentId,
    },
    ports,
  );
};

describe("initialization", () => {
  it("seeds the repository, commits a baseline and cuts the feature branch", async () => {
    const result = await initialize("phoenix-bob", "feature/redis-sessions");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.value.branch).toBe("feature/redis-sessions");
    expect(result.value.filesWritten).toBeGreaterThanOrEqual(15);

    const branch = await nodeGitPort(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      result.value.workspacePath,
    );
    expect(branch.stdout.trim()).toBe("feature/redis-sessions");
  });

  it("writes the dummy .env from the template, since it cannot be committed", async () => {
    const result = await initialize("phoenix-bob", "feature/redis-sessions");
    if (!result.ok) throw new Error(result.safeReason);

    const envPath = path.join(result.value.workspacePath, ".env");
    const contents = await readFile(envPath, "utf8");

    expect(contents).toContain("SESSION_SECRET=");
    // And the template itself was not copied through as a second file.
    expect(
      await nodeFileSystemPort.exists(path.join(result.value.workspacePath, "env.template")),
    ).toBe(false);
  });

  it("preserves the Starter Kit's AGENTS.md and merges its .gitignore", async () => {
    const result = await initialize("phoenix-bob", "feature/redis-sessions");
    if (!result.ok) throw new Error(result.safeReason);

    const agents = await readFile(path.join(result.value.workspacePath, "AGENTS.md"), "utf8");
    expect(agents).toContain("Do not overwrite me");

    const ignore = await readFile(path.join(result.value.workspacePath, ".gitignore"), "utf8");
    expect(ignore).toContain(".codex/");
    expect(ignore).toContain(".env");
  });

  it("creates two independent workspaces on separate branches", async () => {
    const bob = await initialize("phoenix-bob", "feature/redis-sessions");
    const alice = await initialize("phoenix-alice", "feature/google-oauth");
    if (!bob.ok || !alice.ok) throw new Error("both workspaces must initialize");

    expect(bob.value.workspacePath).not.toBe(alice.value.workspacePath);
    const aliceBranch = await nodeGitPort(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      alice.value.workspacePath,
    );
    expect(aliceBranch.stdout.trim()).toBe("feature/google-oauth");
  });

  it("runs the fixture's own tests through the host runner, with no network", async () => {
    const workspacePath = path.join(workspaceRoot, "phoenix-real");
    await nodeFileSystemPort.mkdir(workspacePath);
    const { createNodeTestRunnerPort } = await import("./ports.node.js");

    const result = await initializePhoenixWorkspace(
      {
        workspacePath,
        fixtureRoot: FIXTURE_ROOT,
        branch: "feature/redis-sessions",
        ownerId: "bob",
        agentId: "phoenix-real",
      },
      { ...ports, runFixtureTests: createNodeTestRunnerPort(SERVER_ROOT) },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.testsPassed).toBe(true);
    expect(result.value.testSummary).toMatch(/9 passed/);
    // The fixture has no node_modules of its own.
    expect(
      await nodeFileSystemPort.exists(path.join(workspacePath, "node_modules")),
    ).toBe(false);
  }, 60_000);
});

describe("Bob's contract change", () => {
  const agreement: ActiveAgreement = {
    agreementId: "agr_01",
    proposalVersion: 1,
    state: "active",
    ownership: [
      {
        ownerId: "bob",
        agentId: "phoenix-bob",
        files: ["src/auth/session.ts", "src/auth/session-repository.ts", "src/models/**", "tests/auth/session.test.ts", "src/auth/fake-session-repository.ts", "src/auth/redis-session-repository.ts"],
        interfaces: ["Session", "SessionRepository"],
      },
      {
        ownerId: "alice",
        agentId: "phoenix-alice",
        files: ["src/auth/oauth.ts", "src/routes/**", "tests/auth/oauth.test.ts"],
        interfaces: ["POST /login", "GET /oauth/callback"],
      },
    ],
    dependencyLinks: [
      {
        consumerIntentId: "intent_alice_oauth",
        providerIntentId: "intent_bob_redis",
        interface: "Session",
      },
    ],
    requiredRules: ["Bob must publish any Session contract change."],
  };

  it("makes deviceId required and commits only Bob-owned files", async () => {
    const bob = await initialize("phoenix-bob", "feature/redis-sessions");
    if (!bob.ok) throw new Error(bob.safeReason);

    const change = await applyBobContractChange(bob.value.workspacePath, ports);
    expect(change.ok).toBe(true);
    if (!change.ok) return;

    expect(change.value.changedFiles.sort()).toEqual([...CONTRACT_CHANGE_PATHS].sort());

    const repository = await readFile(
      path.join(bob.value.workspacePath, "src/auth/session-repository.ts"),
      "utf8",
    );
    expect(repository).toContain("deviceId: string;");
    expect(repository).not.toContain("deviceId?: string;");
    expect(repository).toContain("requires deviceId");
  });

  it("produces a diff the ownership gate accepts for Bob", async () => {
    const bob = await initialize("phoenix-bob", "feature/redis-sessions");
    if (!bob.ok) throw new Error(bob.safeReason);
    const change = await applyBobContractChange(bob.value.workspacePath, ports);
    if (!change.ok) throw new Error(change.safeReason);

    const decision = validateChangedPaths({
      changedPaths: change.value.changedFiles,
      agreement,
      actorOwnerId: "bob",
    });

    expect(decision.ok).toBe(true);
  });

  it("produces a diff the ownership gate REJECTS for Alice", async () => {
    const bob = await initialize("phoenix-bob", "feature/redis-sessions");
    if (!bob.ok) throw new Error(bob.safeReason);
    const change = await applyBobContractChange(bob.value.workspacePath, ports);
    if (!change.ok) throw new Error(change.safeReason);

    const decision = validateChangedPaths({
      changedPaths: change.value.changedFiles,
      agreement,
      actorOwnerId: "alice",
    });

    expect(decision).toMatchObject({ ok: false, code: "OWNERSHIP_VIOLATION" });
    if (decision.ok) return;
    expect(decision.offendingPaths).toContain("src/auth/session-repository.ts");
  });

  it("breaks Alice's untouched workspace, which is the point of the demo", async () => {
    const alice = await initialize("phoenix-alice", "feature/google-oauth");
    if (!alice.ok) throw new Error(alice.safeReason);

    const callback = await readFile(
      path.join(alice.value.workspacePath, "src/routes/oauth-callback.ts"),
      "utf8",
    );
    // Alice still calls startSession with an optional device.
    expect(callback).toContain("request.deviceId");
    expect(callback).not.toContain("assertDeviceId");
  });
});

describe("reset", () => {
  it("removes a Phoenix workspace after validating the exact target", async () => {
    const bob = await initialize("phoenix-bob", "feature/redis-sessions");
    if (!bob.ok) throw new Error(bob.safeReason);

    const result = await resetPhoenixWorkspace(
      bob.value.workspacePath,
      workspaceRoot,
      ports,
    );

    expect(result.ok).toBe(true);
    expect(await nodeFileSystemPort.exists(bob.value.workspacePath)).toBe(false);
  });

  it.each([
    ["the workspace root itself", (root: string) => root],
    ["a directory outside the root", () => tmpdir()],
    ["a nested path rather than a workspace", (root: string) => path.join(root, "a", "b")],
  ])("refuses to delete %s", async (_label, target) => {
    const result = await resetPhoenixWorkspace(target(workspaceRoot), workspaceRoot, ports);
    expect(result.ok).toBe(false);
    expect(await nodeFileSystemPort.exists(target(workspaceRoot))).toBe(
      target(workspaceRoot) === path.join(workspaceRoot, "a", "b") ? false : true,
    );
  });

  it("refuses a directory that does not carry the Phoenix marker", async () => {
    const stranger = path.join(workspaceRoot, "not-phoenix");
    await nodeFileSystemPort.mkdir(stranger);
    await nodeFileSystemPort.writeFile(path.join(stranger, "important.txt"), "keep me");

    const result = await resetPhoenixWorkspace(stranger, workspaceRoot, ports);

    expect(result).toMatchObject({ ok: false });
    expect(await nodeFileSystemPort.exists(path.join(stranger, "important.txt"))).toBe(true);
  });
});

describe("git evidence", () => {
  it("reports a clean tree after the baseline commit", async () => {
    const bob = await initialize("phoenix-bob", "feature/redis-sessions");
    if (!bob.ok) throw new Error(bob.safeReason);

    const status = await statusChangedPaths(bob.value.workspacePath, nodeGitPort);
    expect(status).toMatchObject({ ok: true, value: [] });
  });

  it("never commits the dummy .env", async () => {
    const bob = await initialize("phoenix-bob", "feature/redis-sessions");
    if (!bob.ok) throw new Error(bob.safeReason);

    const tracked = await nodeGitPort(["ls-files"], bob.value.workspacePath);
    expect(tracked.stdout).not.toContain(".env");
    expect(tracked.stdout).toContain("src/auth/session-repository.ts");
  });
});

describe("the fixture fits the canonical demo scope", () => {
  it("yields exactly the 8-file maximum for the approved scope", async () => {
    // plan.md §13 approves docs/architecture/**, src/auth/** and tests/auth/**.
    // That resolves to exactly CONTEXT_LIMITS.maxSourceFiles files — the demo
    // sits ON the limit, not under it. Adding one file to src/auth/ or
    // tests/auth/ in the fixture would make ContextPack generation fail with
    // LIMIT_TOO_MANY_FILES *during the live demo*. This test makes that failure
    // happen in CI instead.
    const bob = await initialize("phoenix-bob", "feature/redis-sessions");
    if (!bob.ok) throw new Error(bob.safeReason);

    const approved = normalizeRuleSet([
      "docs/architecture/**",
      "src/auth/**",
      "tests/auth/**",
    ]);
    if (!approved.ok) throw new Error("demo rules must normalize");

    const enumerated = await enumerateApprovedSources(
      approved.value,
      bob.value.workspacePath,
      nodeFileSystemPort,
    );

    // Report the denial rather than asserting a bare boolean. This failed on a
    // Windows checkout as "expected false to be true", which says nothing about
    // which limit or rule rejected the scope - the reason has to be read out of
    // the result to be actionable on a machine the author cannot reproduce on.
    if (!enumerated.ok) {
      throw new Error(
        "approved scope was denied: " +
          enumerated.code +
          " - " +
          enumerated.safeReason +
          " (input: " +
          enumerated.input +
          ")",
      );
    }
    expect(enumerated.value.files).toHaveLength(CONTEXT_LIMITS.maxSourceFiles);
    expect(enumerated.value.totalBytes).toBeLessThan(CONTEXT_LIMITS.maxTotalSourceBytes);
    // And none of them is forbidden material.
    expect(
      enumerated.value.files.some(
        (file) => file.relativePath.includes(".env") || file.relativePath.includes(".git"),
      ),
    ).toBe(false);
  });
});

describe("Windows line endings", () => {
  it("applies the contract change to a CRLF checkout", async () => {
    // Git checks this fixture out with CRLF on Windows — the demo machine. Every
    // anchor in applyBobContractChange is written with LF, so without
    // normalization the change silently finds nothing and reports "anchor not
    // found" on the one machine that matters. Found by running the suite there.
    const bob = await initialize("phoenix-bob", "feature/redis-sessions");
    if (!bob.ok) throw new Error(bob.safeReason);

    for (const relativePath of CONTRACT_CHANGE_PATHS) {
      const absolute = path.join(bob.value.workspacePath, relativePath);
      const text = await readFile(absolute, "utf8");
      // Normalize first: on Windows the checkout is already CRLF, and a naive
      // \n -> \r\n on that produces \r\r\n. Which is itself worth handling,
      // so the last file is left in exactly that state.
      const lf = text.replace(/\r\n/g, "\n");
      const crlf = lf.replace(/\n/g, "\r\n");
      await writeFile(absolute, crlf, "utf8");
    }

    // And one file left with the pathological \r\r\n, which a Windows editor
    // saving an already-CRLF file can genuinely produce.
    const pathological = path.join(bob.value.workspacePath, CONTRACT_CHANGE_PATHS[0]);
    const original = await readFile(pathological, "utf8");
    await writeFile(pathological, original.replace(/\r\n/g, "\r\r\n"), "utf8");

    const change = await applyBobContractChange(bob.value.workspacePath, ports);

    expect(change.ok).toBe(true);
    const repository = await readFile(
      path.join(bob.value.workspacePath, "src/auth/session-repository.ts"),
      "utf8",
    );
    expect(repository).toContain("deviceId: string;");
    expect(repository).not.toContain("deviceId?: string;");
  }, 30_000);
});
