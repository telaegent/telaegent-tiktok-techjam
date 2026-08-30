import { describe, expect, it } from "vitest";
import {
  authorizeSourcePath,
  enumerateApprovedSources,
  normalizeRule,
  normalizeRuleSet,
  normalizeSourcePath,
  resolveInsideWorkspace,
} from "./context-policy.js";
import { createMemoryFileSystem } from "./testing/memory-fs.js";
import { CONTEXT_LIMITS } from "./contract.js";

const ROOT = "/ws/phoenix-bob";

const rules = (...inputs: string[]) => {
  const result = normalizeRuleSet(inputs);
  if (!result.ok) throw new Error("expected rules to normalize: " + result.code);
  return result.value;
};

const seedWorkspace = () => {
  const fs = createMemoryFileSystem();
  fs.addFile(ROOT + "/docs/architecture/auth.md", "# Auth\nSessions live in Redis.\n");
  fs.addFile(ROOT + "/src/auth/session.ts", "export interface Session {}\n");
  fs.addFile(ROOT + "/src/auth/session-repository.ts", "export interface SessionRepository {}\n");
  fs.addFile(ROOT + "/src/routes/login.ts", "export const login = () => {};\n");
  fs.addFile(ROOT + "/tests/auth/session.test.ts", "// test\n");
  fs.addFile(ROOT + "/.env", "ARK_API_KEY=sk-live-do-not-read\n");
  fs.addFile(ROOT + "/.git/config", "[core]\n");
  return fs;
};

describe("path rule grammar", () => {
  it("accepts an exact file and a recursive prefix", () => {
    expect(normalizeRule("src/auth/session.ts")).toMatchObject({
      ok: true,
      value: { kind: "exact", value: "src/auth/session.ts" },
    });
    expect(normalizeRule("src/auth/**")).toMatchObject({
      ok: true,
      value: { kind: "prefix", value: "src/auth" },
    });
  });

  it("strips benign leading ./ without treating it as traversal", () => {
    const result = normalizeRule("./docs/architecture/**");
    expect(result).toMatchObject({ ok: true, value: { value: "docs/architecture" } });
  });

  it.each([
    ["src/**/*.ts", "FORBID_UNSUPPORTED_GLOB"],
    ["src/auth/*.ts", "FORBID_UNSUPPORTED_GLOB"],
    ["src/auth/?ession.ts", "FORBID_UNSUPPORTED_GLOB"],
    ["src/{auth,models}/**", "FORBID_UNSUPPORTED_GLOB"],
    ["src/auth/[a-z].ts", "FORBID_UNSUPPORTED_GLOB"],
    ["**", "FORBID_UNSUPPORTED_GLOB"],
  ])("rejects unsupported glob syntax %s", (input, code) => {
    expect(normalizeRule(input)).toMatchObject({ ok: false, code });
  });

  it("refuses a rule set larger than the approved maximum", () => {
    const six = Array.from({ length: CONTEXT_LIMITS.maxApprovedRules + 1 }, (_, index) =>
      "src/module" + index + "/**",
    );
    expect(normalizeRuleSet(six)).toMatchObject({ ok: false, code: "LIMIT_TOO_MANY_RULES" });
  });
});

describe("absolute, drive and UNC paths", () => {
  it.each([
    ["/etc/passwd", "FORBID_ABSOLUTE_PATH"],
    ["/home/user/.ssh/id_rsa", "FORBID_ABSOLUTE_PATH"],
    ["C:\\Users\\bob\\secrets.txt", "FORBID_DRIVE_OR_UNC"],
    ["c:/Users/bob/notes.md", "FORBID_DRIVE_OR_UNC"],
    ["//server/share/file.md", "FORBID_DRIVE_OR_UNC"],
    ["\\\\server\\share\\file.md", "FORBID_DRIVE_OR_UNC"],
  ])("rejects %s", (input, code) => {
    expect(normalizeSourcePath(input)).toMatchObject({ ok: false, code });
  });
});

describe("traversal", () => {
  it.each([
    "../../etc/passwd",
    "src/../../outside.ts",
    "src/auth/../../../escape.ts",
    "src\\auth\\..\\..\\..\\escape.ts",
    "./../secret.ts",
    "src/./../../up.ts",
  ])("rejects %s after normalizing both separator forms", (input) => {
    expect(normalizeSourcePath(input)).toMatchObject({
      ok: false,
      code: "FORBID_TRAVERSAL",
    });
  });

  it("rejects encoded traversal rather than decoding it", () => {
    expect(normalizeSourcePath("src/%2e%2e/escape.ts")).toMatchObject({
      ok: false,
      code: "FORBID_TRAVERSAL",
    });
  });
});

describe("always-denied names", () => {
  it.each([
    [".env", "FORBID_ENV_FILES"],
    ["./.env", "FORBID_ENV_FILES"],
    [".env.local", "FORBID_ENV_FILES"],
    [".env.production", "FORBID_ENV_FILES"],
    ["config/.env.test", "FORBID_ENV_FILES"],
    [".git/config", "FORBID_GIT_INTERNALS"],
    ["src/.git/HEAD", "FORBID_GIT_INTERNALS"],
    ["deploy/credentials.json", "FORBID_SECRET_NAME"],
    ["src/auth/session-token.ts", "FORBID_SECRET_NAME"],
    ["config/secrets/db.ts", "FORBID_SECRET_NAME"],
    ["ops/api_key.txt", "FORBID_SECRET_NAME"],
    ["keys/server.pem", "FORBID_PRIVATE_KEY_FILE"],
    ["keys/tls.key", "FORBID_PRIVATE_KEY_FILE"],
    [".ssh/id_ed25519", "FORBID_SECRET_NAME"],
    ["home/.aws/config", "FORBID_SECRET_NAME"],
    ["codex-home/sessions/log.jsonl", "FORBID_PROVIDER_HOME"],
    [".claude/projects/transcript.jsonl", "FORBID_PROVIDER_HOME"],
  ])("denies %s", (input, code) => {
    expect(normalizeSourcePath(input)).toMatchObject({ ok: false, code });
  });

  it("denies a forbidden name even when an approved prefix covers it", () => {
    const approved = rules("src/**", "docs/**");
    // `src/**` covers these by membership; step 8 refuses them anyway.
    expect(authorizeSourcePath("src/.env.local", approved)).toMatchObject({
      ok: false,
      code: "FORBID_ENV_FILES",
    });
    expect(authorizeSourcePath("src/config/secret-store.ts", approved)).toMatchObject({
      ok: false,
      code: "FORBID_SECRET_NAME",
    });
  });

  it("refuses a rule that is itself a forbidden path", () => {
    expect(normalizeRule(".env")).toMatchObject({ ok: false, code: "FORBID_ENV_FILES" });
    expect(normalizeRule(".git/**")).toMatchObject({
      ok: false,
      code: "FORBID_GIT_INTERNALS",
    });
  });
});

describe("approval membership", () => {
  const approved = rules("docs/architecture/**", "src/auth/**", "tests/auth/**");

  it("allows a file under an approved prefix", () => {
    expect(authorizeSourcePath("src/auth/session.ts", approved)).toMatchObject({
      ok: true,
      value: "src/auth/session.ts",
    });
  });

  it("refuses a sibling outside every rule", () => {
    expect(authorizeSourcePath("src/routes/login.ts", approved)).toMatchObject({
      ok: false,
      code: "FORBID_UNAPPROVED_PATH",
    });
  });

  it("does not let a prefix rule match a sibling directory by string prefix", () => {
    expect(authorizeSourcePath("src/authority/keys.ts", approved)).toMatchObject({
      ok: false,
      code: "FORBID_UNAPPROVED_PATH",
    });
  });
});

describe("the .env proof", () => {
  it("denies .env before the filesystem is touched at all", async () => {
    const fs = seedWorkspace();
    const approved = rules("src/auth/**");

    const decision = authorizeSourcePath(".env", approved);

    expect(decision).toMatchObject({ ok: false, code: "FORBID_ENV_FILES" });
    // The denial is a string operation. Nothing was opened, stat-ed or copied.
    expect(fs.calls).toHaveLength(0);
  });

  it("never reads or copies .env while enumerating an approved workspace", async () => {
    const fs = seedWorkspace();
    const approved = rules("docs/architecture/**", "src/auth/**", "tests/auth/**");

    const result = await enumerateApprovedSources(approved, ROOT, fs);

    expect(result.ok).toBe(true);
    const touched = [...fs.callsTo("readFile"), ...fs.callsTo("copyFile")];
    expect(touched.some((entry) => entry.endsWith(".env"))).toBe(false);
    expect(fs.calls.some((call) => call.arg.includes("/.git/"))).toBe(false);
  });

  it("still denies .env when the model asks for it by an obfuscated spelling", () => {
    const approved = rules("src/**");
    for (const spelling of ["./.env", ".\\.env", "src/../.env", "src/auth/../../.env"]) {
      expect(authorizeSourcePath(spelling, approved).ok).toBe(false);
    }
  });
});

describe("symlink handling", () => {
  it("refuses a link that resolves outside the workspace", async () => {
    const fs = seedWorkspace();
    fs.addFile("/etc/shadow", "root:x:");
    fs.addSymlink(ROOT + "/src/auth/leak.ts", "/etc/shadow");

    const result = await resolveInsideWorkspace("src/auth/leak.ts", ROOT, fs);

    expect(result).toMatchObject({ ok: false, code: "FORBID_SYMLINK_ESCAPE" });
    expect(fs.callsTo("readFile")).toHaveLength(0);
  });

  it("refuses a link that stays inside, because links are never copied", async () => {
    const fs = seedWorkspace();
    fs.addSymlink(ROOT + "/src/auth/alias.ts", ROOT + "/src/auth/session.ts");

    const result = await resolveInsideWorkspace("src/auth/alias.ts", ROOT, fs);

    expect(result).toMatchObject({ ok: false, code: "FORBID_NOT_REGULAR_FILE" });
  });

  it("refuses a file reached through a symlinked directory", async () => {
    const fs = seedWorkspace();
    fs.addFile("/outside/notes.md", "secret architecture");
    fs.addSymlink(ROOT + "/docs/mirror", "/outside");

    const result = await resolveInsideWorkspace("docs/mirror/notes.md", ROOT, fs);

    expect(result.ok).toBe(false);
    expect(fs.callsTo("readFile")).toHaveLength(0);
  });
});

describe("size and count limits", () => {
  it("refuses a single oversized file", async () => {
    const fs = seedWorkspace();
    fs.addFile(ROOT + "/src/auth/huge.ts", "x".repeat(CONTEXT_LIMITS.maxBytesPerFile + 1));

    const result = await resolveInsideWorkspace("src/auth/huge.ts", ROOT, fs);

    expect(result).toMatchObject({ ok: false, code: "LIMIT_FILE_TOO_LARGE" });
    expect(fs.callsTo("readFile")).toHaveLength(0);
  });

  it("refuses more approved files than the limit allows", async () => {
    const fs = createMemoryFileSystem();
    for (let index = 0; index <= CONTEXT_LIMITS.maxSourceFiles; index += 1) {
      fs.addFile(ROOT + "/src/auth/file" + index + ".ts", "export const x = " + index + ";\n");
    }
    const result = await enumerateApprovedSources(rules("src/auth/**"), ROOT, fs);
    expect(result).toMatchObject({ ok: false, code: "LIMIT_TOO_MANY_FILES" });
  });

  it("refuses an approved set that exceeds the total byte budget", async () => {
    const fs = createMemoryFileSystem();
    const chunk = "x".repeat(CONTEXT_LIMITS.maxBytesPerFile);
    for (let index = 0; index < 3; index += 1) {
      fs.addFile(ROOT + "/src/auth/big" + index + ".ts", chunk);
    }
    const result = await enumerateApprovedSources(rules("src/auth/**"), ROOT, fs);
    expect(result).toMatchObject({ ok: false, code: "LIMIT_TOTAL_TOO_LARGE" });
  });
});

describe("enumeration", () => {
  it("returns only approved regular files, in a stable order", async () => {
    const fs = seedWorkspace();
    const result = await enumerateApprovedSources(
      rules("docs/architecture/**", "src/auth/**"),
      ROOT,
      fs,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files.map((file) => file.relativePath)).toEqual([
      "docs/architecture/auth.md",
      "src/auth/session-repository.ts",
      "src/auth/session.ts",
    ]);
    expect(result.value.totalBytes).toBeGreaterThan(0);
  });
});

/* ========================================================================== *
 * A root that is not its own real path
 * ========================================================================== */

describe("a workspace root that is not already canonical", () => {
  // Reproduces, on a POSIX runner, the mechanism that broke every Windows run:
  // enumerateApprovedSources compares a realpath()-ed child against the root it
  // was handed, so a root that is not real makes every file look like a symlink
  // escape. On Windows the non-real root is an 8.3 short name
  // (C:\Users\HIENPH~1\...); here it is a symlinked ancestor. Same bug, same
  // fix, and this one can actually run in CI.

  it("enumerates files when the root itself is a symlink", async () => {
    const fs = createMemoryFileSystem();
    fs.addFile("/real/ws/src/auth/session.ts", "export interface Session {}\n");
    fs.addFile("/real/ws/src/auth/oauth.ts", "export const oauth = 1;\n");
    fs.addSymlink("/link/ws", "/real/ws");

    const rules = normalizeRuleSet(["src/auth/**"]);
    expect(rules.ok).toBe(true);
    if (!rules.ok) return;

    // The root handed in is the LINK, not the real directory.
    const enumerated = await enumerateApprovedSources(rules.value, "/link/ws", fs);

    expect(enumerated.ok, "a non-canonical root must not deny every file").toBe(true);
    if (!enumerated.ok) return;
    expect(enumerated.value.files.map((file) => file.relativePath).sort()).toEqual([
      "src/auth/oauth.ts",
      "src/auth/session.ts",
    ]);
  });

  it("still refuses a link that escapes the real root", async () => {
    // The fix must not have traded a false denial for a false acceptance.
    //
    // An escaping link aborts the whole enumeration rather than being skipped
    // quietly - consider() treats FORBID_SYMLINK_ESCAPE as a hard failure,
    // because a link pointing out of the workspace means something is actively
    // wrong and partial results would hide it. Asserting the denial rather than
    // a filtered file list is what actually pins that behaviour down.
    const fs = createMemoryFileSystem();
    fs.addFile("/outside/secrets/leak.ts", "export const leak = 1;\n");
    fs.addFile("/real/ws/src/auth/session.ts", "export interface Session {}\n");
    fs.addSymlink("/real/ws/src/auth/escape", "/outside/secrets");

    const rules = normalizeRuleSet(["src/auth/**"]);
    expect(rules.ok).toBe(true);
    if (!rules.ok) return;

    const enumerated = await enumerateApprovedSources(rules.value, "/real/ws", fs);

    expect(enumerated.ok).toBe(false);
    if (enumerated.ok) return;
    expect(enumerated.code).toBe("FORBID_SYMLINK_ESCAPE");
  });

  it("catches an escaping link even when the root is itself a symlink", async () => {
    // Both halves at once: a non-canonical root must not make the escape check
    // pass by accident once the root is canonicalised.
    const fs = createMemoryFileSystem();
    fs.addFile("/outside/secrets/leak.ts", "export const leak = 1;\n");
    fs.addFile("/real/ws/src/auth/session.ts", "export interface Session {}\n");
    fs.addSymlink("/real/ws/src/auth/escape", "/outside/secrets");
    fs.addSymlink("/link/ws", "/real/ws");

    const rules = normalizeRuleSet(["src/auth/**"]);
    expect(rules.ok).toBe(true);
    if (!rules.ok) return;

    const enumerated = await enumerateApprovedSources(rules.value, "/link/ws", fs);

    expect(enumerated.ok).toBe(false);
    if (enumerated.ok) return;
    expect(enumerated.code).toBe("FORBID_SYMLINK_ESCAPE");
  });
});
