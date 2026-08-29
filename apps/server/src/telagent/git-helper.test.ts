import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareReportedChanges,
  createBranch,
  createCheckpointCommit,
  diffNameOnlyFrom,
  parsePorcelainZ,
  statusChangedPaths,
  validateChangedPaths,
} from "./git-helper.js";
import { createRecordingGit } from "./testing/fake-ports.js";
import type { ActiveAgreement } from "./contract.js";

const agreement: ActiveAgreement = {
  agreementId: "agr_01",
  proposalVersion: 1,
  state: "active",
  ownership: [
    {
      ownerId: "alice",
      agentId: "alice-agent",
      files: ["src/auth/oauth.ts", "src/routes/**", "tests/auth/oauth.test.ts"],
      interfaces: ["POST /login", "GET /oauth/callback"],
    },
    {
      ownerId: "bob",
      agentId: "bob-agent",
      files: [
        "src/auth/session.ts",
        "src/auth/session-repository.ts",
        "src/auth/fake-session-repository.ts",
        "src/auth/redis-session-repository.ts",
        "src/models/**",
        "tests/auth/session.test.ts",
      ],
      interfaces: ["Session", "SessionRepository"],
    },
  ],
  dependencyLinks: [],
  requiredRules: ["Bob must publish any Session contract change."],
};

/* ========================================================================== *
 * No shell, no destruction
 * ========================================================================== */

describe("the module cannot emit a dangerous git command", () => {
  it("contains no reset, push, merge, remote or force argv token", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./git-helper.ts", import.meta.url)),
      "utf8",
    );
    // Strip the header comment, which names these commands to say it avoids them.
    const body = source.slice(source.indexOf("import path"));

    // Every argv element this module can emit is a double-quoted literal.
    // Comparing whole literals avoids a substring like "-f" matching prose.
    const literals = new Set(
      [...body.matchAll(/"([^"\n]*)"/g)].map((match) => match[1] ?? ""),
    );

    const forbidden = [
      "reset",
      "push",
      "merge",
      "remote",
      "clean",
      "rm",
      "--hard",
      "--force",
      "-f",
      "-D",
    ];
    expect([...literals].filter((literal) => forbidden.includes(literal))).toEqual([]);
  });

  it("passes arguments as an array, never a concatenated command string", async () => {
    const { git, commands } = createRecordingGit({
      status: { stdout: "" },
      "rev-parse": { stdout: "abc123\n" },
    });
    await statusChangedPaths("/ws", git);
    expect(commands.every((command) => Array.isArray(command))).toBe(true);
    expect(commands.flat().join(" ")).not.toContain("&&");
  });

  it("keeps an injection-shaped commit message as a single argv element", async () => {
    const { git, commands } = createRecordingGit({
      status: { stdout: "M  src/routes/login.ts\0" },
      "rev-parse": { stdout: "abc123\n" },
    });
    const nasty = 'checkpoint"; rm -rf / #';

    await createCheckpointCommit("/ws", nasty, git);

    const commit = commands.find((command) => command.includes("commit"));
    expect(commit).toBeDefined();
    expect(commit).toContain(nasty);
    // One element, not split into a shell fragment.
    expect(commit?.filter((part) => part.includes("rm -rf"))).toHaveLength(1);
  });

  it("refuses an unsafe branch name before running git", async () => {
    const { git, commands } = createRecordingGit();
    for (const branch of ["../escape", "--upload-pack=evil", "feature/..", ""]) {
      const result = await createBranch("/ws", branch, git);
      expect(result.ok).toBe(false);
    }
    expect(commands).toHaveLength(0);
  });
});

/* ========================================================================== *
 * Porcelain parsing
 * ========================================================================== */

describe("status parsing", () => {
  it("splits NUL-delimited records, so spaces in paths survive", () => {
    const stdout = "M  src/routes/oauth callback.ts\0?? docs/new note.md\0";
    expect(parsePorcelainZ(stdout)).toEqual([
      "docs/new note.md",
      "src/routes/oauth callback.ts",
    ]);
  });

  it("skips the second half of a rename record", () => {
    const stdout = "R  src/routes/new.ts\0src/routes/old.ts\0M  src/auth/oauth.ts\0";
    expect(parsePorcelainZ(stdout)).toEqual(["src/auth/oauth.ts", "src/routes/new.ts"]);
  });

  it("deduplicates and sorts", () => {
    expect(parsePorcelainZ("M  a.ts\0M  a.ts\0M  b.ts\0")).toEqual(["a.ts", "b.ts"]);
  });

  it("returns a safe reason, not git stderr, when git fails", async () => {
    const { git } = createRecordingGit({ status: { exitCode: 128 } });
    const result = await statusChangedPaths("/ws", git);
    expect(result).toMatchObject({ ok: false, code: "GIT_FAILED" });
    if (result.ok) return;
    expect(result.safeReason).toBe("git status failed (exit 128)");
    expect(result.safeReason).not.toContain("/ws");
  });

  it("reads a diff from a checkpoint", async () => {
    const { git, commands } = createRecordingGit({
      diff: { stdout: "src/auth/oauth.ts\0src/routes/login.ts\0" },
    });
    const result = await diffNameOnlyFrom("/ws", "af31d4e", git);
    expect(result).toMatchObject({
      ok: true,
      value: ["src/auth/oauth.ts", "src/routes/login.ts"],
    });
    expect(commands[0]).toEqual(["diff", "--name-only", "-z", "af31d4e", "--"]);
  });
});

describe("checkpoint with no changes", () => {
  it("returns HEAD without creating an empty commit", async () => {
    const { git, commands } = createRecordingGit({
      status: { stdout: "" },
      "rev-parse": { stdout: "abc123\n" },
    });
    const result = await createCheckpointCommit("/ws", "nothing to do", git);
    expect(result).toMatchObject({ ok: true, value: { changedFiles: [] } });
    expect(commands.some((command) => command.includes("commit"))).toBe(false);
  });
});

/* ========================================================================== *
 * Ownership
 * ========================================================================== */

describe("ownership validation", () => {
  it("accepts Alice's OAuth diff", () => {
    const result = validateChangedPaths({
      changedPaths: [
        "src/auth/oauth.ts",
        "src/routes/oauth-callback.ts",
        "tests/auth/oauth.test.ts",
      ],
      agreement,
      actorOwnerId: "alice",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts Bob's session diff", () => {
    const result = validateChangedPaths({
      changedPaths: [
        "src/auth/session-repository.ts",
        "src/models/session.ts",
        "tests/auth/session.test.ts",
      ],
      agreement,
      actorOwnerId: "bob",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects Alice touching the Session contract", () => {
    const result = validateChangedPaths({
      changedPaths: ["src/auth/oauth.ts", "src/auth/session-repository.ts"],
      agreement,
      actorOwnerId: "alice",
    });
    expect(result).toMatchObject({ ok: false, code: "OWNERSHIP_VIOLATION" });
    if (result.ok) return;
    expect(result.offendingPaths).toEqual(["src/auth/session-repository.ts"]);
    // The reason names a count, not the contents of anything.
    expect(result.safeReason).toContain("1 path(s)");
  });

  it("rejects any change when no agreement is active", () => {
    const result = validateChangedPaths({
      changedPaths: ["src/auth/oauth.ts"],
      agreement: { ...agreement, state: "proposed" },
      actorOwnerId: "alice",
    });
    expect(result).toMatchObject({ ok: false, code: "OWNERSHIP_VIOLATION" });
  });

  it("rejects a traversal path in a diff", () => {
    const result = validateChangedPaths({
      changedPaths: ["../../etc/passwd"],
      agreement,
      actorOwnerId: "alice",
    });
    expect(result).toMatchObject({ ok: false, code: "OWNERSHIP_VIOLATION" });
  });

  it("allows a shared contract path once it has been published", () => {
    const result = validateChangedPaths({
      changedPaths: ["src/auth/oauth.ts", "src/auth/session-repository.ts"],
      agreement,
      actorOwnerId: "alice",
      publishedContractPaths: ["src/auth/session-repository.ts"],
    });
    expect(result.ok).toBe(true);
  });

  it("is not capped by the five-rule context-approval limit", () => {
    // Bob's ownership lists six paths. That limit is a disclosure budget, not
    // an ownership budget.
    expect(agreement.ownership[1]?.files.length).toBeGreaterThan(5);
    const result = validateChangedPaths({
      changedPaths: ["src/auth/redis-session-repository.ts"],
      agreement,
      actorOwnerId: "bob",
    });
    expect(result.ok).toBe(true);
  });
});

describe("provider-reported changes are only a cross-check", () => {
  it("reports agreement when both lists match", () => {
    expect(compareReportedChanges(["a.ts", "b.ts"], ["b.ts", "a.ts"]).agreed).toBe(true);
  });

  it("surfaces a file the provider under-reported", () => {
    const comparison = compareReportedChanges(
      ["src/auth/oauth.ts", "src/auth/session.ts"],
      ["src/auth/oauth.ts"],
    );
    expect(comparison.agreed).toBe(false);
    expect(comparison.missingFromReport).toEqual(["src/auth/session.ts"]);
  });

  it("normalizes separators before comparing", () => {
    expect(
      compareReportedChanges(["src/auth/oauth.ts"], ["src\\auth\\oauth.ts"]).agreed,
    ).toBe(true);
  });
});
