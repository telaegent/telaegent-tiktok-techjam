import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFileBroker, isBrokerFailure } from "./file-broker.js";
import {
  DEFAULT_RESOURCE_POLICY_LIMITS,
  decideResourceRequest,
  isDeniedPath,
  type AssertedGrant,
  type ResourcePolicyInput,
} from "./resource-policy.js";
import {
  FileResourceRegistry,
  InMemoryResourceRegistry,
  RESOURCE_ID_PATTERN,
} from "./resource-registry.js";

const taskId = "task_one";
const otherTaskId = "task_two";
const peer = "10000000-0000-4000-8000-00000000b002";
const now = new Date("2026-08-31T12:00:00.000Z");
const execFileAsync = promisify(execFile);

let workspace: string;
let outside: string;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telaegent-capability-"));
  workspace = path.join(root, "workspace");
  outside = path.join(root, "outside");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(workspace, "src", "LandingPage.tsx"), "export const page = 1;\n");
  await writeFile(path.join(workspace, ".env"), "SECRET=live-value\n");
  await writeFile(path.join(workspace, ".git", "config"), "[remote]\n");
  await writeFile(path.join(outside, "elsewhere.txt"), "not yours\n");
});

afterAll(async () => {
  await rm(path.dirname(workspace), { recursive: true, force: true });
});

function grant(overrides: Partial<AssertedGrant> = {}): AssertedGrant {
  return {
    grantId: "30000000-0000-4000-8000-000000000001",
    resourceId: `resource_${"a".repeat(24)}`,
    operation: "read",
    mode: "task",
    expiresAt: null,
    ...overrides,
  };
}

function policyInput(overrides: Partial<ResourcePolicyInput> = {}): ResourcePolicyInput {
  return {
    taskId,
    request: { kind: "resource", resourceId: `resource_${"a".repeat(24)}` },
    grants: [grant()],
    canonicalPath: path.join(workspace, "src", "LandingPage.tsx"),
    withinWorkspace: true,
    requestsAlreadyMade: 0,
    bytesAlreadyRead: 0,
    now,
    ...overrides,
  };
}

describe("resource registry", () => {
  it("mints identifiers the cloud constraint will accept", async () => {
    const registry = new InMemoryResourceRegistry(() => now);
    const resourceId = await registry.mint(taskId, path.join(workspace, "src/LandingPage.tsx"));
    expect(resourceId).toMatch(RESOURCE_ID_PATTERN);
  });

  it("returns one identifier per file per task rather than fragmenting it", async () => {
    const registry = new InMemoryResourceRegistry(() => now);
    const file = path.join(workspace, "src/LandingPage.tsx");
    expect(await registry.mint(taskId, file)).toBe(await registry.mint(taskId, file));
  });

  it("never lets an identifier from one task resolve in another", async () => {
    const registry = new InMemoryResourceRegistry(() => now);
    const file = path.join(workspace, "src/LandingPage.tsx");
    const first = await registry.mint(taskId, file);
    const second = await registry.mint(otherTaskId, file);
    // The same file reached through two collaborations is two unrelated
    // identifiers, so one leaked from a finished task cannot be replayed.
    expect(second).not.toBe(first);
    expect(await registry.resolve(otherTaskId, first)).toBeNull();
    expect(await registry.resolve(taskId, first)).toBe(path.resolve(file));
  });

  it("does not derive the identifier from the path it hides", async () => {
    const file = path.join(workspace, "src/LandingPage.tsx");
    const a = await new InMemoryResourceRegistry(() => now).mint(taskId, file);
    const b = await new InMemoryResourceRegistry(() => now).mint(taskId, file);
    // A derived identifier would be a path oracle: a peer could confirm a
    // guessed filename by recomputing it.
    expect(a).not.toBe(b);
  });

  it("survives a connector restart so task-mode grants keep resolving", async () => {
    const file = path.join(workspace, "registry.json");
    const first = new FileResourceRegistry(file, () => now);
    const resourceId = await first.mint(taskId, path.join(workspace, "src/LandingPage.tsx"));
    const reloaded = new FileResourceRegistry(file, () => now);
    expect(await reloaded.resolve(taskId, resourceId)).toBe(
      path.join(workspace, "src", "LandingPage.tsx"),
    );
  });

  it("preserves concurrent mappings from independent registry instances", async () => {
    const file = path.join(workspace, "cross-process-registry.json");
    const first = new FileResourceRegistry(file, () => now);
    const second = new FileResourceRegistry(file, () => now);
    const firstPath = path.join(workspace, "src", "first.ts");
    const secondPath = path.join(workspace, "src", "second.ts");

    const [firstId, secondId] = await Promise.all([
      first.mint(taskId, firstPath),
      second.mint(taskId, secondPath),
    ]);
    const restarted = new FileResourceRegistry(file, () => now);
    await expect(restarted.resolve(taskId, firstId)).resolves.toBe(path.resolve(firstPath));
    await expect(restarted.resolve(taskId, secondId)).resolves.toBe(path.resolve(secondPath));
  });

  it("preserves mappings written concurrently by separate connector processes", async () => {
    const file = path.join(workspace, "multi-process-registry.json");
    const firstPath = path.join(workspace, "src", "process-one.ts");
    const secondPath = path.join(workspace, "src", "process-two.ts");
    const child = fileURLToPath(
      new URL("./test-fixtures/resource-registry-child.mjs", import.meta.url),
    );
    const tsxImport = new URL(
      "../../../../node_modules/tsx/dist/loader.mjs",
      import.meta.url,
    ).href;

    const [first, second] = await Promise.all([
      execFileAsync(process.execPath, ["--import", tsxImport, child, file, taskId, firstPath]),
      execFileAsync(process.execPath, ["--import", tsxImport, child, file, taskId, secondPath]),
    ]);
    const restarted = new FileResourceRegistry(file, () => now);
    await expect(restarted.resolve(taskId, first.stdout.trim())).resolves.toBe(
      path.resolve(firstPath),
    );
    await expect(restarted.resolve(taskId, second.stdout.trim())).resolves.toBe(
      path.resolve(secondPath),
    );
  });

  it("converges concurrent mints for the same task and path", async () => {
    const file = path.join(workspace, "same-entry-registry.json");
    const first = new FileResourceRegistry(file, () => now);
    const second = new FileResourceRegistry(file, () => now);
    const resourcePath = path.join(workspace, "src", "same.ts");

    const [firstId, secondId] = await Promise.all([
      first.mint(taskId, resourcePath),
      second.mint(taskId, resourcePath),
    ]);
    expect(secondId).toBe(firstId);
  });

  it("removes every local handle when the task ends", async () => {
    const file = path.join(workspace, "closed-task-registry.json");
    const registry = new FileResourceRegistry(file, () => now);
    const resourceId = await registry.mint(
      taskId,
      path.join(workspace, "src", "closed.ts"),
    );

    await registry.removeTask(taskId);

    await expect(registry.resolve(taskId, resourceId)).resolves.toBeNull();
  });

  it("retires new mappings at the cloud task's authoritative expiry", async () => {
    const file = path.join(workspace, "expiring-task-registry.json");
    const registry = new FileResourceRegistry(file, () => now);
    const resourceId = await registry.mint(
      taskId,
      path.join(workspace, "src", "expiring.ts"),
      "2026-08-31T12:05:00.000Z",
    );

    await expect(registry.pruneExpired(new Date("2026-08-31T12:04:59.999Z"))).resolves.toBe(0);
    await expect(registry.resolve(taskId, resourceId)).resolves.not.toBeNull();
    await expect(registry.pruneExpired(new Date("2026-08-31T12:05:00.000Z"))).resolves.toBe(1);
    await expect(registry.resolve(taskId, resourceId)).resolves.toBeNull();
  });

  it("retires upgraded legacy mappings after a conservative compatibility window", async () => {
    const file = path.join(workspace, "legacy-expiry-registry.json");
    const resourceId = `resource_${"e".repeat(24)}`;
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        entries: [{
          taskId,
          resourceId,
          canonicalPath: path.join(workspace, "src", "legacy-expiring.ts"),
          issuedAt: now.toISOString(),
        }],
      }),
    );
    const registry = new FileResourceRegistry(file, () => now);

    await expect(registry.pruneExpired(new Date("2026-09-01T11:59:59.999Z"))).resolves.toBe(0);
    await expect(registry.pruneExpired(new Date("2026-09-01T12:00:00.000Z"))).resolves.toBe(1);
    await expect(registry.resolve(taskId, resourceId)).resolves.toBeNull();
  });

  it("does not resurrect a removed task from the legacy import source", async () => {
    const file = path.join(workspace, "legacy-closed-task.json");
    const resourceId = `resource_${"l".repeat(24)}`;
    const canonicalPath = path.join(workspace, "src", "legacy.ts");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        entries: [{ taskId, resourceId, canonicalPath, issuedAt: now.toISOString() }],
      }),
    );
    const registry = new FileResourceRegistry(file, () => now);
    await expect(registry.resolve(taskId, resourceId)).resolves.toBe(canonicalPath);
    await registry.removeTask(taskId);

    const restarted = new FileResourceRegistry(file, () => now);
    await expect(restarted.resolve(taskId, resourceId)).resolves.toBeNull();
  });

  it("refuses to treat a corrupt registry as an empty one", async () => {
    const file = path.join(workspace, "corrupt.json");
    await writeFile(file, "{ not json");
    // Reading it as empty would re-mint identifiers and orphan every live grant.
    await expect(new FileResourceRegistry(file).resolve(taskId, "x")).rejects.toThrow();
    await rm(file, { force: true });
  });

  it("fails before a capacity limit can make durable state unreadable", async () => {
    const file = path.join(workspace, "full-registry.json");
    const entries = Array.from({ length: 2 }, (_, index) => ({
      taskId,
      resourceId: `resource_${index.toString(36).padStart(24, "a")}`,
      canonicalPath: path.join(workspace, "src", `file-${index}.ts`),
      issuedAt: now.toISOString(),
    }));
    await writeFile(file, JSON.stringify({ version: 1, entries }));
    const registry = new FileResourceRegistry(file, () => now, 2);

    await expect(
      registry.mint(taskId, path.join(workspace, "src", "overflow.ts")),
    ).rejects.toThrow("Resource registry capacity exceeded");
    await expect(registry.resolve(taskId, entries[0]!.resourceId)).resolves.toBe(
      entries[0]!.canonicalPath,
    );
  });
});

describe("resource policy", () => {
  it("allows a granted, contained, non-secret resource", () => {
    expect(decideResourceRequest(policyInput(), workspace)).toMatchObject({
      outcome: "allow",
      mode: "task",
    });
  });

  it("refuses a secret even when the human already granted it", () => {
    const decision = decideResourceRequest(
      policyInput({ canonicalPath: path.join(workspace, ".env") }),
      workspace,
    );
    // Screening runs before grant checking, so no approval reached by any route
    // can produce a read of a credential file.
    expect(decision).toEqual({ outcome: "deny", code: "SECRET_PATH" });
  });

  it("treats the git directory as unreadable", () => {
    expect(isDeniedPath(path.join(workspace, ".git", "config"), workspace)).toBe(true);
    expect(isDeniedPath(path.join(workspace, "src", "LandingPage.tsx"), workspace)).toBe(false);
  });

  it("escalates an ungranted resource instead of refusing it", () => {
    const decision = decideResourceRequest(policyInput({ grants: [] }), workspace);
    // Absence of a grant is the cold path, not a denial: the owner has simply
    // never been asked about this resource in this task.
    expect(decision).toMatchObject({ outcome: "escalate" });
  });

  it("always escalates a hint, however plausible it looks", () => {
    const decision = decideResourceRequest(
      policyInput({ request: { kind: "hint", hint: "src/settings.ts" } }),
      workspace,
    );
    // A hint may be a project-relative path (build plan 8.3). It still only ever
    // reaches a human, so a peer can suggest a file but never select one.
    expect(decision).toMatchObject({ outcome: "escalate" });
  });

  it("refuses an expired grant and a non-read grant", () => {
    expect(
      decideResourceRequest(
        policyInput({ grants: [grant({ expiresAt: "2026-08-31T11:59:59.000Z" })] }),
        workspace,
      ),
    ).toEqual({ outcome: "deny", code: "GRANT_EXPIRED" });
    expect(
      decideResourceRequest(
        policyInput({ grants: [grant({ operation: "write" })] }),
        workspace,
      ),
    ).toEqual({ outcome: "deny", code: "GRANT_OPERATION" });
  });

  it("refuses an identifier this task never held", () => {
    expect(
      decideResourceRequest(policyInput({ canonicalPath: null }), workspace),
    ).toEqual({ outcome: "deny", code: "UNKNOWN_RESOURCE" });
  });

  it("stops a runaway loop on request and byte budgets", () => {
    expect(
      decideResourceRequest(
        policyInput({ requestsAlreadyMade: DEFAULT_RESOURCE_POLICY_LIMITS.maxRequestsPerTask }),
        workspace,
      ),
    ).toEqual({ outcome: "deny", code: "REQUEST_BUDGET" });
    expect(
      decideResourceRequest(
        policyInput({ bytesAlreadyRead: DEFAULT_RESOURCE_POLICY_LIMITS.maxBytesPerTask }),
        workspace,
      ),
    ).toEqual({ outcome: "deny", code: "BYTE_BUDGET" });
  });
});

describe("local file broker", () => {
  function readInput(canonicalPath: string, maxBytes = 65_536) {
    return {
      taskId,
      resourceId: `resource_${"a".repeat(24)}`,
      recipientUserId: peer,
      canonicalPath,
      authorizationMode: "task" as const,
      maxBytes,
    };
  }

  it("delivers the file with audit metadata that is not a copy of it", async () => {
    const broker = new LocalFileBroker(workspace);
    const result = await broker.read(
      readInput(path.join(workspace, "src", "LandingPage.tsx")),
      () => now,
    );
    expect(isBrokerFailure(result)).toBe(false);
    if (isBrokerFailure(result)) return;
    expect(result.content).toBe("export const page = 1;\n");
    expect(result.audit.byteLength).toBe(23);
    expect(result.audit.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.audit.truncated).toBe(false);
    // Build plan 8.6: record the snapshot, never the contents.
    expect(JSON.stringify(result.audit)).not.toContain("export const page");
  });

  it("bounds an oversized file rather than transferring it whole", async () => {
    const result = await new LocalFileBroker(workspace).read(
      readInput(path.join(workspace, "src", "LandingPage.tsx"), 6),
      () => now,
    );
    if (isBrokerFailure(result)) throw new Error("expected a delivery");
    expect(result.content).toBe("export");
    expect(result.audit.truncated).toBe(true);
  });

  it("re-screens the secret at read time, not only at policy time", async () => {
    const result = await new LocalFileBroker(workspace).read(
      readInput(path.join(workspace, ".env")),
      () => now,
    );
    expect(result).toEqual({ code: "SECRET_PATH" });
  });

  it("refuses a path outside the workspace and a directory", async () => {
    const broker = new LocalFileBroker(workspace);
    expect(await broker.read(readInput(path.join(outside, "elsewhere.txt")), () => now)).toEqual({
      code: "OUTSIDE_WORKSPACE",
    });
    expect(await broker.read(readInput(path.join(workspace, "src")), () => now)).toEqual({
      code: "UNREADABLE",
    });
  });
});
