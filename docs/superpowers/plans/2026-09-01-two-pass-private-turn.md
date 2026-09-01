# Two-Pass Private Turn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the private drafting agent a real investigation budget by running an investigate pass before the draft pass inside one connector job, and stream that investigation to the owner as visible file-by-file activity.

**Architecture:** `ConnectorWorker.runOnce` currently starts one `ProviderSessionManager.run` promise and races it against a cancellation watcher. It will instead start a `runTurn` promise that awaits an ephemeral investigation run and then the existing drafting run. Keeping both passes inside that one promise means the existing cancellation watcher, abort signal, and cleanup cover the investigation for free. The Claude runner gains tool-activity emission (it emits none today), and every activity target passes through the workspace containment check at the single point where progress crosses to the cloud.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Node >=22, Zod, Vitest (`*.test.ts` colocated beside source).

**Spec:** `docs/superpowers/specs/2026-09-01-agent-intelligence-layer-design.md`

**Scope note:** This plan implements spec sections 3.1 and 4 only. Spec section 3.2 (durable project facts, which needs a Supabase migration) and section 3.3 (grant-list injection) are independent subsystems and get their own plans. This plan produces working, testable software on its own.

## Global Constraints

- **Never edit `apps/web/`.** Another engineer owns it.
- **No secret, path, prompt, or model text may reach the cloud.** `text_delta` stays dropped in `ConnectorWorker`'s progress sink.
- **The cloud may never request an investigation.** `jobSchema.purpose` in `connector-worker.ts` stays `z.enum(["sender_draft", "recipient_answer"])` and `jobSchema.maxTurns` stays `z.number().int().min(1).max(3)`. The investigation request is built locally from a job that already passed that check, so `authorization/authorized-private-runtime-turn.ts` needs no change at all — a deliberate simplification of the spec, which proposed a purpose-dependent cloud cap.
- **`sandboxMode` is `"read-only"` and `networkMode` is `"none"`** on both passes. Never widen either.
- **Investigation turn budget: 12.** Draft turn budget: unchanged (cloud policy, max 3).
- **Investigation note budget: 8000 characters**, enforced by the JSON Schema's `maxLength`.
- **Do not add `Co-Authored-By` trailers or any Claude attribution to commit messages.**
- Run `npm run typecheck -w apps/server` before each commit, and `npx vitest run <file>` for the task's own tests.

---

## File Structure

**Create:**
- `apps/server/src/telagent/output-schemas/investigation-note.schema.json` — the investigation pass's output contract. One field. Structurally cannot be a message.
- `apps/server/src/connectors/workspace-label.ts` — the containment primitive, extracted so resource delivery and progress reporting share one implementation.
- `apps/server/src/connectors/workspace-label.test.ts`
- `apps/server/src/telagent/protocol/prompts/investigate.ts` — the investigation role instruction.
- `apps/server/src/telagent/protocol/prompts/investigate.test.ts`
- `apps/server/src/connectors/connector-worker-two-pass.test.ts` — two-pass behaviour, target containment, note containment.

**Modify:**
- `apps/server/src/connectors/resource-exchange.ts` — delete the local `projectRelativeDisplayLabel`, import it instead.
- `apps/server/src/runtime-contract.ts` — optional `target` on activity events.
- `apps/server/src/connectors/routes.ts` — accept the bounded `target`.
- `apps/server/src/claude-code-runner.ts` — emit tool activity (it emits none today).
- `apps/server/src/connectors/connector-worker.ts` — sanitize `target`; run the two passes.

---

### Task 1: Investigation output schema

The investigation pass runs through the same `runStructured` path as everything else. Giving it a one-field schema — rather than a new freeform provider code path — means no change to `MiddlewareProviderRunner`, no second implementation in the Codex runner, and a note whose size is bounded declaratively. It still cannot produce a message: there is no `sendCandidate`, no `state`, and no `resourceRequests` field for anything to land in.

**Files:**
- Create: `apps/server/src/telagent/output-schemas/investigation-note.schema.json`
- Test: `apps/server/src/telagent/output-schemas/investigation-note.test.ts`

**Interfaces:**
- Consumes: `FileOutputSchemaResolver` from `apps/server/src/runtime-provider-registry.ts`.
- Produces: schema name `"investigation-note.schema.json"`. Parsed shape: `{ note: string }`, 0–8000 characters.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/telagent/output-schemas/investigation-note.test.ts`:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FileOutputSchemaResolver } from "../../runtime-provider-registry.js";

const schemaRoot = path.dirname(fileURLToPath(import.meta.url));

describe("investigation-note.schema.json", () => {
  it("resolves through the standard schema resolver", async () => {
    const resolver = new FileOutputSchemaResolver(schemaRoot);
    const schema = await resolver.resolve("investigation-note.schema.json");
    expect(schema).toMatchObject({
      type: "object",
      required: ["note"],
      additionalProperties: false,
    });
  });

  it("cannot carry a message: no sendCandidate, state, or resourceRequests", async () => {
    const resolver = new FileOutputSchemaResolver(schemaRoot);
    const schema = await resolver.resolve("investigation-note.schema.json");
    const properties = (schema as unknown as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties)).toEqual(["note"]);
    expect(properties.sendCandidate).toBeUndefined();
    expect(properties.state).toBeUndefined();
    expect(properties.resourceRequests).toBeUndefined();
  });

  it("bounds the note so it cannot grow without limit", async () => {
    const resolver = new FileOutputSchemaResolver(schemaRoot);
    const schema = await resolver.resolve("investigation-note.schema.json");
    const note = (
      schema as unknown as { properties: { note: { maxLength: number } } }
    ).properties.note;
    expect(note.maxLength).toBe(8000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/telagent/output-schemas/investigation-note.test.ts`
Expected: FAIL — the resolver raises `RUNTIME_UNAVAILABLE` because the file does not exist.

Note: if `FileOutputSchemaResolver`'s constructor differs from `new FileOutputSchemaResolver(root)`, read `apps/server/src/runtime-provider-registry.ts` and match the real signature. Do not change the resolver.

- [ ] **Step 3: Create the schema**

Create `apps/server/src/telagent/output-schemas/investigation-note.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "note": {
      "type": "string",
      "maxLength": 8000
    }
  },
  "required": [
    "note"
  ],
  "additionalProperties": false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/telagent/output-schemas/investigation-note.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Check the protocol drift guard**

Run: `npx vitest run apps/server/src/telagent/protocol/`
Expected: PASS. The protocol suite fails when a turn schema drifts from its Zod parser. If it enumerates the schema directory and now objects to a file with no Zod counterpart, add `investigation-note.schema.json` to that test's exclusion of non-turn schemas — it is deliberately not a protocol turn. Do not add a turn parser for it.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/telagent/output-schemas/investigation-note.schema.json apps/server/src/telagent/output-schemas/investigation-note.test.ts
git commit -m "feat(protocol): add the investigation-note output schema"
```

---

### Task 2: Extract the workspace containment label

`projectRelativeDisplayLabel` is a private function in `resource-exchange.ts`. Progress reporting needs the same check, and a security primitive with two consumers should have exactly one implementation.

**Files:**
- Create: `apps/server/src/connectors/workspace-label.ts`
- Create: `apps/server/src/connectors/workspace-label.test.ts`
- Modify: `apps/server/src/connectors/resource-exchange.ts` (delete the local copy near line 204, import instead)

**Interfaces:**
- Consumes: `resourceDisplayLabelSchema` from `./resource-request.js` (max 512 chars; rejects control characters, backslashes, and absolute or drive-prefixed paths).
- Produces: `export function projectRelativeDisplayLabel(workspacePath: string, canonicalPath: string): string | null` — a forward-slash path relative to the workspace, or `null` when the target resolves outside it.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/connectors/workspace-label.test.ts`:

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectRelativeDisplayLabel } from "./workspace-label.js";

const workspace = path.resolve("/repo");

describe("projectRelativeDisplayLabel", () => {
  it("returns a forward-slash relative label for a contained path", () => {
    expect(
      projectRelativeDisplayLabel(workspace, path.join(workspace, "src", "auth", "session.ts")),
    ).toBe("src/auth/session.ts");
  });

  it("returns null for a sibling directory that shares a prefix", () => {
    expect(
      projectRelativeDisplayLabel(workspace, path.resolve("/repo-secrets/keys.env")),
    ).toBeNull();
  });

  it("returns null for a parent traversal", () => {
    expect(
      projectRelativeDisplayLabel(workspace, path.join(workspace, "..", "other", "a.ts")),
    ).toBeNull();
  });

  it("returns null for the workspace root itself", () => {
    expect(projectRelativeDisplayLabel(workspace, workspace)).toBeNull();
  });

  it("returns null for a home-directory path outside the workspace", () => {
    expect(
      projectRelativeDisplayLabel(workspace, path.resolve("/home/dev/.aws/credentials")),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/connectors/workspace-label.test.ts`
Expected: FAIL — cannot resolve `./workspace-label.js`.

- [ ] **Step 3: Create the module**

Create `apps/server/src/connectors/workspace-label.ts`:

```ts
import path from "node:path";
import { resourceDisplayLabelSchema } from "./resource-request.js";

/**
 * The single containment check for anything derived from a local path that a
 * human or the cloud will see.
 *
 * Returns a workspace-relative label, or null when the path resolves anywhere
 * else. Null is the safe answer and every caller must treat it as "say
 * nothing" rather than falling back to the original value.
 */
export function projectRelativeDisplayLabel(
  workspacePath: string,
  canonicalPath: string,
): string | null {
  const relative = path.relative(path.resolve(workspacePath), path.resolve(canonicalPath));
  if (!relative || path.isAbsolute(relative)) return null;
  const label = relative.split(path.sep).join("/");
  const parsed = resourceDisplayLabelSchema.safeParse(label);
  return parsed.success ? parsed.data : null;
}
```

Note: this is a move, not a rewrite. Open the existing function in `resource-exchange.ts` first and carry its exact logic across, including any check the body above does not show. If the real implementation differs, the real implementation wins — it is the one the existing containment tests have been proving.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/connectors/workspace-label.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Point resource-exchange at the shared copy**

In `apps/server/src/connectors/resource-exchange.ts`, delete the local function definition (it begins `function projectRelativeDisplayLabel(` around line 204 and ends at its closing brace) and add to the import block at the top of the file:

```ts
import { projectRelativeDisplayLabel } from "./workspace-label.js";
```

Leave every call site unchanged — the signature is identical.

- [ ] **Step 6: Verify nothing regressed**

Run: `npx vitest run apps/server/src/connectors/ && npm run typecheck -w apps/server`
Expected: PASS, no type errors. The existing `resource-exchange` suites must still pass unchanged — they are the standing proof that containment works.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/connectors/workspace-label.ts apps/server/src/connectors/workspace-label.test.ts apps/server/src/connectors/resource-exchange.ts
git commit -m "refactor(connector): extract the workspace containment label"
```

---

### Task 3: Optional target on activity progress events

**Files:**
- Modify: `apps/server/src/runtime-contract.ts` (the `activity_started | activity_completed` member of `RuntimeProgressEvent`)
- Modify: `apps/server/src/connectors/routes.ts` (the activity member of `progressSchema`)
- Test: `apps/server/src/connectors/connector-progress-target.test.ts` (create)

**Interfaces:**
- Consumes: `resourceDisplayLabelSchema` from `./resource-request.js`.
- Produces: `RuntimeProgressEvent` variant `{ type: "activity_started" | "activity_completed"; provider: AgentProvider; activity: RuntimeActivity; target?: string }`, and `export const progressSchemaForTests` from `connectors/routes.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/connectors/connector-progress-target.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { progressSchemaForTests } from "./routes.js";

describe("progress target", () => {
  it("accepts an activity event with a workspace-relative target", () => {
    expect(
      progressSchemaForTests.parse({
        type: "activity_started",
        provider: "claude",
        activity: "tool",
        target: "src/auth/session.ts",
      }),
    ).toMatchObject({ target: "src/auth/session.ts" });
  });

  it("accepts an activity event with no target", () => {
    const parsed = progressSchemaForTests.parse({
      type: "activity_started",
      provider: "claude",
      activity: "tool",
    });
    expect(parsed).not.toHaveProperty("target");
  });

  it("rejects an absolute target", () => {
    expect(() =>
      progressSchemaForTests.parse({
        type: "activity_started",
        provider: "claude",
        activity: "tool",
        target: "/home/dev/.aws/credentials",
      }),
    ).toThrow();
  });

  it("rejects a backslash target", () => {
    expect(() =>
      progressSchemaForTests.parse({
        type: "activity_started",
        provider: "claude",
        activity: "tool",
        target: "C:\\repo\\src\\a.ts",
      }),
    ).toThrow();
  });

  it("still rejects text_delta on the progress route", () => {
    expect(() =>
      progressSchemaForTests.parse({
        type: "text_delta",
        provider: "claude",
        text: "the API key is sk-live-1234",
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/connectors/connector-progress-target.test.ts`
Expected: FAIL — `progressSchemaForTests` is not exported from `./routes.js`.

- [ ] **Step 3: Widen the contract type**

In `apps/server/src/runtime-contract.ts`, replace the activity member of `RuntimeProgressEvent`:

```ts
  | {
      type: "activity_started" | "activity_completed";
      provider: AgentProvider;
      activity: RuntimeActivity;
      /**
       * Workspace-relative name of what the activity touched, or absent.
       *
       * The connector computes this through `projectRelativeDisplayLabel` and
       * omits it for anything outside the workspace. It is the only local
       * detail permitted to cross; prompts, command arguments, tool output,
       * and model reasoning remain excluded.
       */
      target?: string;
    }
```

The file's contract comment currently states that progress "deliberately excludes prompts, command arguments, tool output, and model reasoning". That sentence stays true and stays as it is. If any neighbouring comment says activity events carry no target at all, update that one — a stale comment on a trust boundary is worse than no comment.

- [ ] **Step 4: Widen the route schema**

In `apps/server/src/connectors/routes.ts`, add `resourceDisplayLabelSchema` to the existing import from `./resource-request.js` (or add the import if there is none):

```ts
import { resourceDisplayLabelSchema } from "./resource-request.js";
```

Replace the activity member of `progressSchema`:

```ts
  z.strictObject({
    type: z.enum(["activity_started", "activity_completed"]),
    provider: providerSchema,
    activity: z.enum(["command", "file_change", "mcp", "web_search", "tool"]),
    target: resourceDisplayLabelSchema.optional(),
  }),
```

Match the surrounding members exactly — if the existing activity member spells the provider or activity enum differently, keep that spelling and add only the `target` line.

Then, immediately after the `progressSchema` declaration closes, add:

```ts
/** Exported so the transport contract can be asserted without a live route. */
export const progressSchemaForTests = progressSchema;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/server/src/connectors/connector-progress-target.test.ts && npm run typecheck -w apps/server`
Expected: PASS (5 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/runtime-contract.ts apps/server/src/connectors/routes.ts apps/server/src/connectors/connector-progress-target.test.ts
git commit -m "feat(runtime): allow a workspace-relative target on activity events"
```

---

### Task 4: Emit tool activity from the Claude runner

`parseClaudeStreamLine` emits `session_started`, `retrying`, `turn_started`, `text_delta`, and `turn_completed` — and no activity events at all. Without this task the investigation pass streams nothing and the owner watches a spinner for the longest phase of the turn.

Claude Code's `stream-json` output carries one `{"type":"assistant","message":{"content":[...]}}` event per assistant message, whose content blocks include complete `tool_use` blocks with their full `input`. Use those rather than `content_block_start`, whose `input` is still empty when the block starts.

**Files:**
- Modify: `apps/server/src/claude-code-runner.ts` (add the two helpers above `export function parseClaudeStreamLine`; insert the emission inside it, immediately before `if (event.type !== "result") return;`)
- Test: `apps/server/src/claude-code-runner.activity.test.ts` (create)

**Interfaces:**
- Consumes: `RuntimeActivity` and `RuntimeProgressEvent` from `./runtime-contract.js`; `ParsedClaudeEvents`, already exported from `claude-code-runner.ts` as `{ sessionId: string | null; structuredOutput: unknown; resultText: string | null; resultSubtype: string | null; errors: string[] }`.
- Produces: `export function claudeToolActivity(toolName: string): RuntimeActivity | null` and `export function claudeToolTarget(input: unknown): string | null`. `parseClaudeStreamLine` keeps its exact signature `(line: string, parsed: ParsedClaudeEvents, onProgress?: RuntimeProgressSink) => void` and emits `activity_started` with a **raw, unsanitized** `target`. Sanitizing is Task 5's job.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/claude-code-runner.activity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RuntimeProgressEvent } from "./runtime-contract.js";
import {
  claudeToolActivity,
  claudeToolTarget,
  parseClaudeStreamLine,
  type ParsedClaudeEvents,
} from "./claude-code-runner.js";

function freshParsed(): ParsedClaudeEvents {
  return {
    sessionId: null,
    structuredOutput: undefined,
    resultText: null,
    resultSubtype: null,
    errors: [],
  };
}

function collect(event: unknown): RuntimeProgressEvent[] {
  const events: RuntimeProgressEvent[] = [];
  parseClaudeStreamLine(JSON.stringify(event), freshParsed(), (progress) => {
    events.push(progress);
  });
  return events;
}

describe("claudeToolActivity", () => {
  it("maps read-only tools to tool", () => {
    expect(claudeToolActivity("Read")).toBe("tool");
    expect(claudeToolActivity("Glob")).toBe("tool");
    expect(claudeToolActivity("Grep")).toBe("tool");
  });

  it("maps shells to command and writes to file_change", () => {
    expect(claudeToolActivity("Bash")).toBe("command");
    expect(claudeToolActivity("PowerShell")).toBe("command");
    expect(claudeToolActivity("Edit")).toBe("file_change");
    expect(claudeToolActivity("Write")).toBe("file_change");
  });

  it("maps web and mcp tools", () => {
    expect(claudeToolActivity("WebFetch")).toBe("web_search");
    expect(claudeToolActivity("WebSearch")).toBe("web_search");
    expect(claudeToolActivity("mcp__github__list_issues")).toBe("mcp");
  });

  it("returns null for an unknown tool rather than guessing", () => {
    expect(claudeToolActivity("StructuredOutput")).toBeNull();
    expect(claudeToolActivity("")).toBeNull();
  });
});

describe("claudeToolTarget", () => {
  it("reads file_path", () => {
    expect(claudeToolTarget({ file_path: "/repo/src/a.ts" })).toBe("/repo/src/a.ts");
  });

  it("prefers file_path over path", () => {
    expect(claudeToolTarget({ file_path: "/repo/a.ts", path: "/repo" })).toBe("/repo/a.ts");
  });

  it("falls back to path", () => {
    expect(claudeToolTarget({ path: "/repo/src" })).toBe("/repo/src");
  });

  it("returns null when there is no path-shaped input", () => {
    expect(claudeToolTarget({ pattern: "TODO" })).toBeNull();
    expect(claudeToolTarget({ command: "ls" })).toBeNull();
    expect(claudeToolTarget(null)).toBeNull();
  });
});

describe("parseClaudeStreamLine activity", () => {
  it("emits activity_started with a target for a Read tool_use block", () => {
    expect(
      collect({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "let me look" },
            { type: "tool_use", name: "Read", input: { file_path: "/repo/src/auth/session.ts" } },
          ],
        },
      }),
    ).toEqual([
      {
        type: "activity_started",
        provider: "claude",
        activity: "tool",
        target: "/repo/src/auth/session.ts",
      },
    ]);
  });

  it("emits one event per tool_use block", () => {
    expect(
      collect({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Glob", input: { path: "/repo/src" } },
            { type: "tool_use", name: "Read", input: { file_path: "/repo/a.ts" } },
          ],
        },
      }),
    ).toHaveLength(2);
  });

  it("omits target when the tool has no path input", () => {
    expect(
      collect({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "TODO" } }] },
      }),
    ).toEqual([{ type: "activity_started", provider: "claude", activity: "tool" }]);
  });

  it("ignores an unknown tool", () => {
    expect(
      collect({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "StructuredOutput", input: {} }] },
      }),
    ).toEqual([]);
  });

  it("ignores a malformed assistant event without throwing", () => {
    expect(() => collect({ type: "assistant" })).not.toThrow();
    expect(collect({ type: "assistant", message: { content: "nope" } })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/claude-code-runner.activity.test.ts`
Expected: FAIL — `claudeToolActivity` is not exported.

- [ ] **Step 3: Implement the mapping**

In `apps/server/src/claude-code-runner.ts`, add these two exported functions immediately above `export function parseClaudeStreamLine`:

```ts
/**
 * Maps a Claude Code tool name onto the provider-neutral activity vocabulary.
 *
 * Unknown tools return null and are not reported. Silence is the correct
 * default for a name this build does not recognise: an unmapped tool is more
 * likely to be a new capability than a read, and inventing a category for it
 * would put a guess in front of the owner.
 */
export function claudeToolActivity(toolName: string): RuntimeActivity | null {
  if (toolName.startsWith("mcp__")) return "mcp";
  switch (toolName) {
    case "Read":
    case "Glob":
    case "Grep":
      return "tool";
    case "Bash":
    case "PowerShell":
      return "command";
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return "file_change";
    case "WebFetch":
    case "WebSearch":
      return "web_search";
    default:
      return null;
  }
}

/**
 * The path-shaped argument of a tool call, exactly as the model wrote it.
 *
 * Deliberately unsanitized: this is still on the owner's machine, and the
 * connector applies workspace containment before anything crosses. Returning
 * a raw path here keeps that single enforcement point honest — it receives
 * escapes and rejects them, rather than being handed pre-filtered input.
 */
export function claudeToolTarget(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}
```

Add `RuntimeActivity` to this file's existing type import from `./runtime-contract.js` if it is not already there.

- [ ] **Step 4: Emit from the stream parser**

Inside `parseClaudeStreamLine`, insert this block immediately **before** the line `if (event.type !== "result") return;`:

```ts
  if (event.type === "assistant" && event.message && typeof event.message === "object") {
    const content = (event.message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const toolUse = block as Record<string, unknown>;
        if (toolUse.type !== "tool_use" || typeof toolUse.name !== "string") continue;
        const activity = claudeToolActivity(toolUse.name);
        if (!activity) continue;
        const target = claudeToolTarget(toolUse.input);
        emitProgress(onProgress, {
          type: "activity_started",
          provider: "claude",
          activity,
          ...(target ? { target } : {}),
        });
      }
    }
  }
```

Emit through whatever helper the surrounding code already uses for progress — the other branches in this function show it. If they call `onProgress?.({...})` directly, do that instead of `emitProgress`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/server/src/claude-code-runner.activity.test.ts apps/server/src/claude-code-runner.test.ts && npm run typecheck -w apps/server`
Expected: PASS. `claude-code-runner.test.ts` must still pass. An `assistant` event previously produced no events and now produces activity, so if an existing test asserts an exact event list for a stream containing tool calls, update that expectation — do not suppress the emission to keep an old assertion green.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/claude-code-runner.ts apps/server/src/claude-code-runner.activity.test.ts
git commit -m "feat(claude): emit tool activity with the touched path"
```

---

### Task 5: Contain activity targets at the trust boundary

The progress callback inside `ConnectorWorker.runOnce` is the last local hop before an event reaches the cloud. Containment belongs there: one place, both providers, and it receives raw model-authored paths so the check is exercised by real input.

This task is tested through `runOnce` against a fake transport — the worker's public surface — not by reaching into a private method.

**Files:**
- Modify: `apps/server/src/connectors/connector-worker.ts` (the inline progress callback passed to `this.sessions.run` in `runOnce`, around lines 176-181)
- Test: `apps/server/src/connectors/connector-worker-two-pass.test.ts` (create; Task 7 appends to the same file)

**Interfaces:**
- Consumes: `projectRelativeDisplayLabel` from `./workspace-label.js` (Task 2); the `target` field from Task 3.
- Produces: private method `ConnectorWorker.forwardProgress(jobId: string, event: RuntimeProgressEvent): void`. Every event reaching `transport.progress` has either a workspace-relative `target` or no `target` at all.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/connectors/connector-worker-two-pass.test.ts`. This harness mirrors the one in the existing `connector-worker.test.ts` — open that file first and copy its import paths, its `binding` and `job` fixtures, and its `FakeTransport` shape rather than trusting the reproduction below where the two differ.

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemoryProviderSessionStore,
  ProviderSessionManager,
} from "../provider-session-manager.js";
import type {
  MiddlewareRunRequest,
  NormalizedRunResult,
  RuntimeProgressEvent,
  RuntimeProgressSink,
} from "../runtime-contract.js";
import { ConnectorWorker, type ConnectorWorkerTransport } from "./connector-worker.js";
import type { ConnectorJobRequest, ConnectorJobResult } from "./connector-turn-executor.js";
import type { ConnectorDelivery } from "./long-poll-job-relay.js";
import type { ResourceExchangeResponse } from "./resource-exchange.js";

const workspacePath = path.resolve("/repo");

const binding = {
  connectorBindingId: "50000000-0000-4000-8000-000000000005",
  authenticatedUserId: "10000000-0000-4000-8000-000000000001",
  githubRepositoryId: "9223372036854775807",
  workspacePath,
};

const job: ConnectorJobRequest = {
  jobId: "60000000-0000-4000-8000-000000000006",
  connectorBindingId: binding.connectorBindingId,
  userId: binding.authenticatedUserId,
  githubRepositoryId: binding.githubRepositoryId,
  conversationId: "70000000-0000-4000-8000-000000000007",
  provider: "claude",
  purpose: "recipient_answer",
  runtimePrompt: "How does session refresh work?",
  persistedSummary: "Approved history",
  sessionMode: "continue",
  sandboxMode: "read-only",
  networkMode: "none",
  outputSchemaName: "recipient-turn.schema.json",
  correlationId: "answer-1",
  maxTurns: 2,
};

const draftFinal = {
  state: "ready",
  assistantMessage: "ok",
  sendCandidate: "ok",
  riskFlags: [],
  referencedPaths: [],
};

class FakeTransport implements ConnectorWorkerTransport {
  readonly progressEvents: RuntimeProgressEvent[] = [];
  readonly results: ConnectorJobResult[] = [];
  readonly failures: string[] = [];
  private deliveries: ConnectorDelivery[] = [{ kind: "job", job }];

  async poll(signal?: AbortSignal): Promise<ConnectorDelivery | null> {
    const delivery = this.deliveries.shift();
    if (delivery) return delivery;
    if (!signal) return null;
    // Park until the worker aborts the watcher, exactly as the production long
    // poll does. Returning null in a loop would busy-spin the cancellation
    // watcher for the whole test.
    return await new Promise((resolve) => {
      if (signal.aborted) return resolve(null);
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
  }

  async progress(_jobId: string, event: RuntimeProgressEvent): Promise<void> {
    this.progressEvents.push(event);
  }

  async result(_jobId: string, result: ConnectorJobResult): Promise<void> {
    this.results.push(result);
  }

  async failure(_jobId: string, code: string): Promise<void> {
    this.failures.push(code);
  }

  async resourceResponse(_response: ResourceExchangeResponse): Promise<void> {}
}

function sessions(
  run: (
    request: MiddlewareRunRequest,
    onProgress?: RuntimeProgressSink,
  ) => Promise<NormalizedRunResult>,
) {
  return new ProviderSessionManager(
    { run },
    new InMemoryProviderSessionStore(),
    async (_scope, request) => request,
  );
}

function ok(final: unknown): NormalizedRunResult {
  return { provider: "claude", final, changedFiles: [], exitCode: 0, durationMs: 1 };
}

describe("activity target containment", () => {
  it("forwards an in-workspace target as a relative label and drops an escape", async () => {
    const transport = new FakeTransport();
    const worker = new ConnectorWorker(
      binding,
      sessions(async (request, onProgress) => {
        // Emit only from the drafting pass. Task 7 adds an investigation pass
        // ahead of it through this same fake runtime, and this guard is what
        // keeps the exact event assertion below true once it does.
        if (request.outputSchemaName !== "recipient-turn.schema.json") {
          return ok(draftFinal);
        }
        onProgress?.({
          type: "activity_started",
          provider: "claude",
          activity: "tool",
          target: path.join(workspacePath, "src", "auth", "session.ts"),
        });
        onProgress?.({
          type: "activity_started",
          provider: "claude",
          activity: "tool",
          target: path.resolve("/home/dev/.aws/credentials"),
        });
        onProgress?.({
          type: "activity_started",
          provider: "claude",
          activity: "tool",
          target: path.join(workspacePath, "..", "other", "a.ts"),
        });
        onProgress?.({ type: "text_delta", provider: "claude", text: "sk-live-1234" });
        onProgress?.({ type: "turn_completed", provider: "claude" });
        return ok(draftFinal);
      }),
      transport,
      { cancel: async () => true },
    );

    await worker.runOnce();

    const activity = transport.progressEvents.filter(
      (event) => event.type === "activity_started",
    );
    expect(activity).toEqual([
      {
        type: "activity_started",
        provider: "claude",
        activity: "tool",
        target: "src/auth/session.ts",
      },
      { type: "activity_started", provider: "claude", activity: "tool" },
      { type: "activity_started", provider: "claude", activity: "tool" },
    ]);
    expect(JSON.stringify(transport.progressEvents)).not.toContain("sk-live-1234");
    expect(JSON.stringify(transport.progressEvents)).not.toContain(".aws");
    expect(transport.progressEvents.some((event) => event.type === "turn_completed")).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/connectors/connector-worker-two-pass.test.ts`
Expected: FAIL — the absolute and traversal targets are forwarded verbatim, so the `toEqual` comparison fails and the `.aws` assertion fails.

- [ ] **Step 3: Implement the sink**

In `apps/server/src/connectors/connector-worker.ts`, add the import:

```ts
import { projectRelativeDisplayLabel } from "./workspace-label.js";
```

Replace the inline progress callback inside `runOnce` — the arrow function containing `if (event.type === "text_delta") return;` and the `void this.transport.progress(...)` call, together with the comment above it — with:

```ts
      (event) => {
        this.forwardProgress(job.jobId, event);
      },
```

Then add this private method to `ConnectorWorker`, immediately above `private scope(`:

```ts
  /**
   * The last local hop before progress reaches the cloud.
   *
   * Raw provider text is private working state: the cloud receives only
   * structural status, and the bounded final result travels through `result`.
   * An activity target is a model-authored path, so it crosses only after the
   * workspace containment check rewrites it to a relative label; anything
   * resolving elsewhere loses its target and is reported as a bare activity.
   * The activity itself is always forwarded — suppressing the event would tell
   * the owner less about what their agent did, which is the opposite of the
   * point.
   */
  private forwardProgress(jobId: string, event: RuntimeProgressEvent): void {
    if (event.type === "text_delta") return;
    let safe: RuntimeProgressEvent = event;
    if (event.type === "activity_started" || event.type === "activity_completed") {
      const { target, ...rest } = event;
      const label =
        target === undefined
          ? null
          : projectRelativeDisplayLabel(this.binding.workspacePath, target);
      safe = label === null ? rest : { ...rest, target: label };
    }
    void this.transport.progress(jobId, safe).catch(() => undefined);
  }
```

If `binding` is not already a named property on the class, use whatever the constructor bound it to — `runOnce` and `scope` both reference it and show the real name.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/connectors/ && npm run typecheck -w apps/server`
Expected: PASS, no type errors. The existing `connector-worker.test.ts` must still pass — `text_delta` is still dropped and every other event still forwarded.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/connectors/connector-worker.ts apps/server/src/connectors/connector-worker-two-pass.test.ts
git commit -m "feat(connector): contain activity targets at the trust boundary"
```

---

### Task 6: The investigation prompt

**Files:**
- Create: `apps/server/src/telagent/protocol/prompts/investigate.ts`
- Create: `apps/server/src/telagent/protocol/prompts/investigate.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `export const INVESTIGATION_ROLE_INSTRUCTION: string` and `export function buildInvestigationPrompt(draftPrompt: string): string`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/telagent/protocol/prompts/investigate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { INVESTIGATION_ROLE_INSTRUCTION, buildInvestigationPrompt } from "./investigate.js";

describe("investigation prompt", () => {
  it("tells the agent it cannot send and is not writing the answer", () => {
    expect(INVESTIGATION_ROLE_INSTRUCTION).toMatch(/cannot send/i);
    expect(INVESTIGATION_ROLE_INSTRUCTION).toMatch(/not writing the answer/i);
  });

  it("forbids copying secret values into the note", () => {
    expect(INVESTIGATION_ROLE_INSTRUCTION).toMatch(/never copy a secret value/i);
  });

  it("carries the draft prompt through so the agent knows what to look for", () => {
    const prompt = buildInvestigationPrompt("Teammate asks: how does session refresh work?");
    expect(prompt).toContain("how does session refresh work?");
    expect(prompt).toContain(INVESTIGATION_ROLE_INSTRUCTION);
  });

  it("is stable for the same input", () => {
    expect(buildInvestigationPrompt("x")).toBe(buildInvestigationPrompt("x"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/telagent/protocol/prompts/investigate.test.ts`
Expected: FAIL — cannot resolve `./investigate.js`.

- [ ] **Step 3: Write the prompt**

Create `apps/server/src/telagent/protocol/prompts/investigate.ts`:

```ts
/**
 * INVESTIGATION PROMPT - the first of two passes in a private turn.
 *
 * This pass exists because the drafting pass cannot both read a repository and
 * produce a strict JSON object inside three turns. It reads; the second pass
 * writes. Its output schema has one string field, so it has no structural way
 * to produce a message, a state, or a resource request.
 *
 * The note it produces stays on the owner's machine. It is appended to the
 * drafting prompt in the same process and is never persisted or transmitted.
 */

export const INVESTIGATION_ROLE_INSTRUCTION = `You are the research pass of a private coding agent, working inside a copy of
your owner's repository. Another pass will write the actual reply; you are not
writing the answer and you cannot send anything to anyone.

Your only job is to find out what is true in this repository, so the next pass
can write a grounded reply instead of a plausible one.

How to work:

1. Read before concluding. Open the files that would settle the question. Follow
   imports and call sites rather than guessing from names.
2. Record what you found, with the file it came from. A claim without a path is
   not useful to the next pass.
3. Record what you could not establish. "The refresh path is in
   src/auth/session.ts; I could not find where the cookie is cleared on logout"
   is a good note. Silence about the gap is not.
4. Never copy a secret value into your note. Not a key, not a token, not a
   password, not a connection string with credentials in it. If a value looks
   like a credential, write down the variable name and the file, never the
   value.
5. Be brief. You are writing for another pass, not for a person. No preamble, no
   restating the question, no offer to help further.

Return one JSON object with a single "note" field containing your findings.`;

/**
 * The investigation prompt for one turn.
 *
 * The drafting prompt is included verbatim so the research pass looks for the
 * right thing. It already carries the untrusted-data envelope the shared prompt
 * builder applied, so no additional framing is added here.
 */
export function buildInvestigationPrompt(draftPrompt: string): string {
  return [
    INVESTIGATION_ROLE_INSTRUCTION,
    "The pass after you must answer the following. Investigate accordingly.",
    draftPrompt,
  ].join("\n\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/telagent/protocol/prompts/investigate.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/telagent/protocol/prompts/investigate.ts apps/server/src/telagent/protocol/prompts/investigate.test.ts
git commit -m "feat(protocol): add the investigation pass prompt"
```

---

### Task 7: Run both passes in one connector job

The final behaviour change. The cloud still dispatches one job and still receives one schema-valid turn object; the extra provider run happens entirely inside `runOnce`.

**Both passes go inside the single `execution` promise.** This is a requirement, not a style choice. `runOnce` races `execution` against a cancellation watcher that long-polls for a cancel delivery and also serves `resource_request` deliveries mid-turn, and its `finally` block joins and cleans up both. Awaiting the investigation *before* creating `execution` would leave the longest phase of the turn — twelve turns rather than two — with no watcher polling: cloud cancels ignored, resource requests unserved. Wrapping both passes in one promise gives the investigation the identical cancellation, abort, and cleanup coverage the draft already has, for no new machinery.

The ordering guarantee behind the existing `await Promise.resolve()` still holds: `runTurn` runs synchronously into `investigate`, which runs synchronously into `sessions.run`, which registers itself on the per-scope queue before its first real await.

The investigation runs with `sessionMode: "ephemeral"`, which `ProviderSessionManager` handles by calling the runtime directly and never touching the session store — so a research pass cannot consume, rotate, or pollute the conversation's provider session.

**Files:**
- Modify: `apps/server/src/connectors/connector-worker.ts`
- Test: `apps/server/src/connectors/connector-worker-two-pass.test.ts` (append to the file created in Task 5)

**Interfaces:**
- Consumes: `buildInvestigationPrompt` from `../telagent/protocol/prompts/investigate.js` (Task 6); the schema name `"investigation-note.schema.json"` (Task 1); `forwardProgress` (Task 5); `ManagedAgentTurnRequest` and `ManagedAgentTurnResult` from `../provider-session-manager.js`.
- Produces: private `ConnectorWorker.runTurn(job, signal): Promise<ManagedAgentTurnResult>`, private `ConnectorWorker.investigate(job, signal): Promise<string>` returning the note or `""`, and `ConnectorWorker.request(job, investigationNote)` gaining a second parameter.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/connectors/connector-worker-two-pass.test.ts`:

```ts
describe("two-pass private turn", () => {
  function twoPassWorker(
    run: (request: MiddlewareRunRequest) => Promise<NormalizedRunResult>,
  ): { worker: ConnectorWorker; transport: FakeTransport; requests: MiddlewareRunRequest[] } {
    const transport = new FakeTransport();
    const requests: MiddlewareRunRequest[] = [];
    const worker = new ConnectorWorker(
      binding,
      sessions(async (request) => {
        requests.push(request);
        return await run(request);
      }),
      transport,
      { cancel: async () => true },
    );
    return { worker, transport, requests };
  }

  const byPass = async (request: MiddlewareRunRequest) =>
    request.outputSchemaName === "investigation-note.schema.json"
      ? ok({ note: "Refresh lives in src/auth/session.ts" })
      : ok(draftFinal);

  it("runs investigation first, then the draft, in one job", async () => {
    const { worker, requests } = twoPassWorker(byPass);
    await worker.runOnce();

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      outputSchemaName: "investigation-note.schema.json",
      sessionMode: "ephemeral",
      sandboxMode: "read-only",
      networkMode: "none",
      purpose: "recipient_answer",
      maxTurns: 12,
    });
    expect(requests[1]).toMatchObject({
      outputSchemaName: "recipient-turn.schema.json",
      sandboxMode: "read-only",
      networkMode: "none",
      maxTurns: 2,
    });
    // The draft went through the session store; the investigation did not.
    expect(requests[1].sessionMode).not.toBe("ephemeral");
  });

  it("feeds the note into the drafting prompt", async () => {
    const { worker, requests } = twoPassWorker(byPass);
    await worker.runOnce();

    expect(requests[0].runtimePrompt).toContain("How does session refresh work?");
    expect(requests[1].runtimePrompt).toContain("Refresh lives in src/auth/session.ts");
    expect(requests[1].runtimePrompt).toContain("How does session refresh work?");
  });

  it("never lets the note reach the cloud", async () => {
    const secret = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI";
    const { worker, transport } = twoPassWorker(async (request) =>
      request.outputSchemaName === "investigation-note.schema.json"
        ? ok({ note: secret })
        : ok(draftFinal),
    );
    await worker.runOnce();

    expect(transport.results).toHaveLength(1);
    expect(JSON.stringify(transport.results)).not.toContain(secret);
    expect(JSON.stringify(transport.progressEvents)).not.toContain(secret);
  });

  it("still drafts when investigation fails", async () => {
    const { worker, transport, requests } = twoPassWorker(async (request) => {
      if (request.outputSchemaName === "investigation-note.schema.json") {
        throw new Error("provider exploded");
      }
      return ok(draftFinal);
    });

    expect(await worker.runOnce()).toBe("completed");
    expect(transport.failures).toEqual([]);
    expect(transport.results).toHaveLength(1);
    expect(requests[1].runtimePrompt).toBe(job.runtimePrompt);
  });

  it("drafts with the original prompt when the note is not a usable string", async () => {
    const { worker, requests } = twoPassWorker(async (request) =>
      request.outputSchemaName === "investigation-note.schema.json"
        ? ok({ note: 42 })
        : ok(draftFinal),
    );
    await worker.runOnce();

    expect(requests[1].runtimePrompt).toBe(job.runtimePrompt);
  });
});
```

Note on the first assertion: `runOnce`'s return value is asserted only in the failure test. Check what the existing `connector-worker.test.ts` expects from a successful `runOnce` and use that literal — if it is not `"completed"`, use the real one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/connectors/connector-worker-two-pass.test.ts`
Expected: FAIL — only one request is recorded, so `expect(requests).toHaveLength(2)` fails.

- [ ] **Step 3: Add the constants and imports**

In `apps/server/src/connectors/connector-worker.ts`, add `ManagedAgentTurnResult` to the existing type import from `../provider-session-manager.js`, and add:

```ts
import { buildInvestigationPrompt } from "../telagent/protocol/prompts/investigate.js";
```

Add these constants beside the file's other module-level constants:

```ts
/**
 * The investigation pass's budget.
 *
 * It is larger than any drafting budget on purpose, and it is safe to be
 * larger for a structural reason rather than a policy one: this pass is bound
 * to a one-field output schema, so it has no shape in which to return a
 * message, a state, or a resource request. It can read and it cannot send.
 *
 * The cloud never selects it. `jobSchema` still refuses any purpose other than
 * the two drafting purposes and any `maxTurns` above 3; this request is built
 * here, from a job that already passed that check.
 */
const INVESTIGATION_MAX_TURNS = 12;
const INVESTIGATION_SCHEMA_NAME = "investigation-note.schema.json";
```

- [ ] **Step 4: Add the two-pass turn**

Add these two private methods to `ConnectorWorker`, immediately above `private request(`:

```ts
  /**
   * One private turn: research, then draft.
   *
   * Both passes live inside this single promise so `runOnce`'s cancellation
   * watcher, abort signal, and cleanup cover the investigation exactly as they
   * cover the draft. Splitting them would leave the longer pass unwatched.
   */
  private async runTurn(
    job: Readonly<ConnectorJobRequest>,
    signal: AbortSignal,
  ): Promise<ManagedAgentTurnResult> {
    const investigationNote = await this.investigate(job, signal);
    return await this.sessions.run(
      this.scope(job),
      this.request(job, investigationNote),
      (event) => {
        this.forwardProgress(job.jobId, event);
      },
      undefined,
      undefined,
      signal,
    );
  }

  /**
   * The research pass. Its note never leaves this process.
   *
   * Failure is not an error: a turn that could not investigate is still a turn
   * the owner is waiting for, so every failure path returns an empty note and
   * lets the drafting pass run exactly as it did before two passes existed.
   */
  private async investigate(
    job: Readonly<ConnectorJobRequest>,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const result = await this.sessions.run(
        this.scope(job),
        {
          agentId: this.binding.connectorBindingId,
          connectorBindingId: this.binding.connectorBindingId,
          workspacePath: this.binding.workspacePath,
          purpose: job.purpose,
          runtimePrompt: buildInvestigationPrompt(job.runtimePrompt),
          persistedSummary: job.persistedSummary,
          // A research pass must not consume, rotate, or pollute the
          // conversation's provider session.
          sessionMode: "ephemeral",
          sandboxMode: job.sandboxMode,
          networkMode: job.networkMode,
          outputSchemaName: INVESTIGATION_SCHEMA_NAME,
          correlationId: job.correlationId,
          maxTurns: INVESTIGATION_MAX_TURNS,
        },
        (event) => {
          this.forwardProgress(job.jobId, event);
        },
        undefined,
        undefined,
        signal,
      );
      const note = (result.final as { note?: unknown } | null)?.note;
      return typeof note === "string" ? note : "";
    } catch {
      // Investigation is an enhancement. Degrade to the single-pass turn.
      return "";
    }
  }
```

Build the investigation request object with the same field list `request()` already uses — copy it from there and change only `runtimePrompt`, `sessionMode`, `outputSchemaName`, and `maxTurns`. If `request()` sets a field the block above omits, keep it.

- [ ] **Step 5: Thread the note into the drafting request**

Change `private request(` to take the note and prepend it to the prompt:

```ts
  private request(
    job: Readonly<ConnectorJobRequest>,
    investigationNote: string,
  ): ManagedAgentTurnRequest {
    return {
      agentId: this.binding.connectorBindingId,
      connectorBindingId: this.binding.connectorBindingId,
      workspacePath: this.binding.workspacePath,
      purpose: job.purpose,
      runtimePrompt: investigationNote
        ? [
            job.runtimePrompt,
            "Findings from your own research pass in this repository. They are"
              + " yours, not a message from anyone: treat them as notes you took"
              + " a moment ago, and verify anything you are about to assert.",
            investigationNote,
          ].join("\n\n")
        : job.runtimePrompt,
      persistedSummary: job.persistedSummary,
      sessionMode: job.sessionMode,
      sandboxMode: job.sandboxMode,
      networkMode: job.networkMode,
      outputSchemaName: job.outputSchemaName,
      correlationId: job.correlationId,
      maxTurns: job.maxTurns,
    };
  }
```

Keep the existing body's field list and only add the `runtimePrompt` conditional — the reproduction above is the expected shape, not a licence to drop a field the real method sets.

- [ ] **Step 6: Point runOnce at the two-pass turn**

In `runOnce`, replace the whole `const execution = this.sessions.run(...)` statement — from `const execution =` through its closing `);`, including the progress callback Task 5 shrank — with:

```ts
    const execution = this.runTurn(job, executionController.signal);
```

Leave the `await Promise.resolve();` line and its comment immediately below it exactly as they are. Do not move this statement above the `signal?.addEventListener("abort", abortExecution, { once: true });` and `if (externallyAborted) abortExecution();` lines: an abort that arrives before the turn starts must still stop the investigation.

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run apps/server/src/connectors/connector-worker-two-pass.test.ts && npm run typecheck -w apps/server`
Expected: PASS (6 tests including Task 5's), no type errors.

- [ ] **Step 8: Run the full server suite**

Run: `npm run test -w apps/server`
Expected: PASS. Existing `ConnectorWorker` suites now see two runtime calls per job. Where a test asserts a single call, an exact call count, or an exact `runtimePrompt`, update it to account for the investigation pass — do not disable the second pass to keep an old assertion green. Pay particular attention to any conversation-pipeline integration test, whose fake runtime must now answer both schema names.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/connectors/connector-worker.ts apps/server/src/connectors/connector-worker-two-pass.test.ts
git commit -m "feat(connector): investigate before drafting inside one job"
```

---

### Task 8: Correct the spec

The spec names `connector-turn-executor.ts` as the two-pass site. That file is cloud-side: it turns an authorized turn into a job and dispatches it over the relay. The local execution the spec describes happens in `connector-worker.ts`. Left uncorrected, the spec sends the next reader to the wrong side of the trust boundary. Two other decisions also changed during planning and should be recorded where the spec asserts otherwise.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-agent-intelligence-layer-design.md`

- [ ] **Step 1: Fix the execution site**

In section 3.1, change `` `connector-turn-executor` job `` (line 83) to `` `connector-worker` job ``.

In the section 5 table, delete the `connectors/connector-turn-executor.ts` row and replace the `connectors/connector-worker.ts` row with:

```
| `connectors/connector-worker.ts` | Emits `target` via `projectRelativeDisplayLabel()`; keeps dropping `text_delta`; runs pass 1 then pass 2 inside one execution promise; the note never leaves the process |
```

- [ ] **Step 2: Record the two revised decisions**

In section 3.1, replace the paragraph beginning "**The turn cap becomes purpose-dependent.**" and the paragraph after it with:

```
**The turn cap stays where it is.** No new `RunPurpose` is added and
`authorized-private-runtime-turn.ts` is unchanged. The investigation request is
built locally by the connector from a job that already passed `jobSchema`, so
the cloud has no way to ask for one: `purpose` still admits only the two
drafting purposes and `maxTurns` is still capped at 3 in transport. A local
constant sets the investigation budget to 12.

The security argument for opening the budget only there: the investigation pass
is bound to a one-field output schema, so it cannot produce a `sendCandidate`.
Its output is structurally not a message. It has no ability to send, and
everything it feeds remains capped, guarded, and human-approved. The tight
ceiling stays exactly where outbound content is produced.
```

In section 3.1's code block, change the pass 1 line `no --json-schema, --max-turns 12,` to `investigation-note schema, --max-turns 12,`. The pass runs through the existing `runStructured` rails with a trivial schema rather than a new schema-less code path — one field, `maxLength` 8000, no way to shape a message.

In the section 5 table, change the `authorization/authorized-private-runtime-turn.ts` row's change column to `Unchanged — the investigation never crosses the cloud boundary`, and change the `runtime-contract.ts` row to drop the `RunPurpose` addition, leaving only `activity_started` gains optional `target`.

In section 8, replace the bullet "An investigation request carrying an output schema is rejected at construction." with "The cloud cannot request an investigation: `jobSchema` rejects any purpose but the two drafting purposes and any `maxTurns` above 3."

- [ ] **Step 3: Verify no stale reference remains**

Run: `grep -n "connector-turn-executor\|private_investigation\|purpose-dependent" docs/superpowers/specs/2026-09-01-agent-intelligence-layer-design.md`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-01-agent-intelligence-layer-design.md
git commit -m "docs: correct the two-pass execution site and turn-cap decision"
```

---

## Manual steps for Phuong

Nothing in this plan requires a database migration or a paid eval run. Section 3.2 of the spec does, and it is not in this plan.

1. **Publish `@telaegent/connector` 0.1.10** after Task 7 lands — the two-pass logic ships inside the connector. From the repo root: `npm publish -w @telaegent/connector` (add `--otp=<code>` if 2FA is on).
2. **Install 0.1.10 on both demo machines.** A machine left on 0.1.9 runs the old single-pass turn and will silently look worse on camera.
3. **Watch one live turn** before shooting, to confirm file names appear as the agent reads. If they do not, the Claude CLI's `assistant` event shape has changed and Task 4's parser needs the real payload — capture one turn's raw `stream-json` output and match it.
