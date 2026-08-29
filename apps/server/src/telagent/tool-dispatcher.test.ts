import { describe, expect, it } from "vitest";
import { executeToolCall, NEVER_DISPATCHABLE } from "./tool-dispatcher.js";
import type { AuthorizedToolCall, DispatchContext } from "./ports.js";
import type { ActiveAgreement, PermissionDecision, ResolvedSourceGrant } from "./contract.js";
import { TELAGENT_TOOL_NAMES } from "./contract.js";
import { createInMemoryPorts } from "./testing/fake-ports.js";
import { BOB_STATUS_RESULT } from "./testing/fake-runners.js";

const ALLOW_METADATA: PermissionDecision = {
  kind: "allow",
  permissionClass: "AUTO_METADATA",
  safeScope: {},
};

const grant: ResolvedSourceGrant = {
  permissionClass: "RECIPIENT_SOURCE_APPROVAL",
  contextRequestId: "req_ctx_01",
  approvedPaths: ["docs/architecture/**", "src/auth/**"],
  approvedByOwnerIds: ["bob"],
  targetVersion: 1,
  expiresAt: "2026-08-28T02:15:00.000Z",
  sourceCommit: "af31d4e",
  taskScope: "task:google-oauth",
};

const agreement: ActiveAgreement = {
  agreementId: "agr_01",
  proposalVersion: 1,
  state: "active",
  ownership: [
    {
      ownerId: "alice",
      agentId: "alice-agent",
      files: ["src/auth/oauth.ts", "src/routes/**", "tests/auth/oauth.test.ts"],
      interfaces: ["POST /login"],
    },
    {
      ownerId: "bob",
      agentId: "bob-agent",
      files: ["src/auth/session.ts", "src/auth/session-repository.ts"],
      interfaces: ["Session"],
    },
  ],
  dependencyLinks: [],
  requiredRules: [],
};

const call = (
  name: AuthorizedToolCall["name"],
  args: unknown,
  decision: PermissionDecision = ALLOW_METADATA,
  actor = { ownerId: "alice", agentId: "alice-agent" },
): AuthorizedToolCall => ({
  callId: "call_1",
  name,
  arguments: args,
  permissionDecision: decision,
  actor,
  projectId: "phoenix",
  correlationId: "corr_1",
});

const bobIntent = {
  intentId: "intent_bob_redis",
  ownerId: "bob",
  agentId: "bob-agent",
  interfaces: ["Session"],
  dependencies: [],
} as unknown as DispatchContext["activeIntents"][number];

const context = (overrides: Partial<DispatchContext> = {}): DispatchContext => ({
  conversationId: "conv_1",
  intentId: "intent_alice_oauth",
  activeIntents: [bobIntent],
  workspacePath: "/ws/phoenix-alice",
  provider: "codex",
  exchangeNumber: 1,
  ...overrides,
});

/* ========================================================================== *
 * Invariant 2 — a tool can never authorize itself
 * ========================================================================== */

describe("permission is never resolved inside the dispatcher", () => {
  it("refuses a call that still needs a human", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call("relay_request_context", {}, {
        kind: "ask_human",
        permissionClass: "RECIPIENT_SOURCE_APPROVAL",
        approverOwnerIds: ["bob"],
        expiresAt: "2026-08-28T02:15:00.000Z",
        safeScope: {},
      }),
      context(),
      ports,
    );
    expect(result).toMatchObject({ kind: "denied", code: "PERMISSION_NOT_RESOLVED" });
  });

  it("refuses a denied call and echoes the deterministic rule", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call("relay_request_context", {}, {
        kind: "deny",
        permissionClass: "ALWAYS_DENY",
        code: "FORBID_ENV_FILES",
        safeReason: "Environment files are never shareable.",
      }),
      context(),
      ports,
    );
    expect(result).toMatchObject({ kind: "denied", code: "FORBID_ENV_FILES" });
  });

  it("refuses to generate a pack without a resolved grant", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call("relay_create_context_pack", {
        contextRequestId: "req_ctx_01",
        topic: "Redis session architecture",
        summary: "Sessions go through SessionRepository.",
        implementationSteps: ["Use the existing SessionRepository"],
        validationChecklist: ["Logout removes the session key"],
        sources: [
          { path: "src/auth/session-repository.ts", commit: "af31d4e", sha256: "a".repeat(64) },
        ],
        taskScope: "task:google-oauth",
        expiresAt: "2026-08-28T02:15:00.000Z",
      }),
      context(),
      ports,
    );
    expect(result).toMatchObject({ kind: "denied", code: "PERMISSION_NOT_RESOLVED" });
    expect(ports.runner.calls).toHaveLength(0);
  });
});

describe("every tool is accounted for", () => {
  it("either dispatches or is explicitly never dispatchable", async () => {
    const ports = createInMemoryPorts();
    const unhandled: string[] = [];

    for (const name of TELAGENT_TOOL_NAMES) {
      const result = await executeToolCall(call(name, {}), context(), ports);
      const explained =
        NEVER_DISPATCHABLE.includes(name) ||
        result.kind === "escalate" || // schema rejected the empty args: it has an executor
        result.kind === "denied";
      if (!explained) unhandled.push(name);
    }
    expect(unhandled).toEqual([]);
  });

  it("refuses relay_request_human_decision even when it arrives authorized", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call("relay_request_human_decision", {
        reasonCode: "stale_status",
        question: "Bob's status is stale. Continue?",
        options: ["Wait for Bob", "Escalate"],
      }),
      context(),
      ports,
    );
    expect(result).toMatchObject({ kind: "denied", code: "TOOL_NOT_DISPATCHABLE" });
  });
});

/* ========================================================================== *
 * Invariant 1 — arguments are re-parsed here
 * ========================================================================== */

describe("arguments are untrusted even after the permission engine", () => {
  it("escalates on malformed arguments instead of executing", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call("relay_publish_intent", { task: "", branch: "..", plannedFiles: [] }),
      context(),
      ports,
    );
    expect(result).toMatchObject({ kind: "escalate", code: "INVALID_AGENT_OUTPUT" });
  });

  it("rejects unknown fields rather than passing them through", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call("relay_publish_intent", {
        task: "Add Google OAuth",
        branch: "feature/google-oauth",
        baseCommit: "af31d4e",
        plannedFiles: ["src/auth/oauth.ts"],
        interfaces: [],
        dependencies: [],
        plan: [],
        permissionClass: "AUTO_METADATA",
      }),
      context(),
      ports,
    );
    expect(result).toMatchObject({ kind: "escalate" });
  });

  it("denies a forbidden planned file at publish time", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call("relay_publish_intent", {
        task: "Add Google OAuth",
        branch: "feature/google-oauth",
        baseCommit: "af31d4e",
        plannedFiles: ["src/auth/oauth.ts", ".env"],
        interfaces: [],
        dependencies: [],
        plan: [],
      }),
      context(),
      ports,
    );
    expect(result).toMatchObject({ kind: "denied", code: "FORBID_ENV_FILES" });
  });

  it("stops the exchange when the bounded limit is exceeded", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call("relay_ask_status", { targetIntentId: "intent_bob_redis", purpose: "status" }),
      context({ exchangeNumber: 4 }),
      ports,
    );
    expect(result).toMatchObject({ kind: "escalate", code: "EXCHANGE_LIMIT" });
    expect(ports.runner.calls).toHaveLength(0);
  });
});

/* ========================================================================== *
 * Context requests
 * ========================================================================== */

describe("relay_request_context", () => {
  const args = {
    topic: "Redis session architecture",
    purpose: "Implement Google OAuth",
    requestedPaths: ["docs/architecture/**", "src/auth/**", "tests/auth/**"],
    persistence: "current-task-only" as const,
  };

  it("creates a permission request that names exactly what will be stored", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(call("relay_request_context", args), context(), ports);

    expect(result.kind).toBe("artifact");
    if (result.kind !== "artifact") return;
    expect(result.entry.type).toBe("permission_request");
    expect(result.entry.payload.requestedRules).toEqual([
      "docs/architecture/**",
      "src/auth/**",
      "tests/auth/**",
    ]);
    expect(result.entry.payload.willNotShare).toContain("environment files");
  });

  it("denies a .env request before a human is ever asked, and opens nothing", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call("relay_request_context", { ...args, requestedPaths: [".env"] }),
      context(),
      ports,
    );

    expect(result).toMatchObject({ kind: "denied", code: "FORBID_ENV_FILES" });
    // The whole point: no filesystem call of any kind happened.
    expect(ports.fs.calls).toHaveLength(0);
    expect(ports.runner.calls).toHaveLength(0);
  });

  it("refuses a traversal request, and opens nothing either way", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call("relay_request_context", { ...args, requestedPaths: ["../../etc/**"] }),
      context(),
      ports,
    );
    // Two layers refuse this. Duy's `pathRuleSchema` rejects traversal during
    // the re-parse, so it escalates as invalid output before the path policy is
    // reached; `context-policy.test.ts` proves the policy would deny it too.
    // What matters here is identical: nothing was opened.
    expect(result.kind).not.toBe("artifact");
    expect(ports.fs.calls).toHaveLength(0);
  });
});

/* ========================================================================== *
 * Cross-agent status
 * ========================================================================== */

describe("relay_ask_status", () => {
  const args = { targetIntentId: "intent_bob_redis", purpose: "Session contract overlap" };

  it("runs the recipient read-only, with no network, and returns bounded status", async () => {
    const ports = createInMemoryPorts({
      script: [{ purpose: "status", final: BOB_STATUS_RESULT }],
      now: new Date("2026-08-28T02:00:00.000Z"),
    });

    const result = await executeToolCall(call("relay_ask_status", args), context(), ports);

    expect(result.kind).toBe("artifact");
    if (result.kind !== "artifact") return;
    expect(result.entry.payload.progress).toBe(60);
    expect(result.entry.payload.stale).toBe(false);

    const request = ports.runner.callsFor("status")[0];
    expect(request?.sandboxMode).toBe("read-only");
    expect(request?.networkMode).toBe("none");
    expect(request?.sessionMode).toBe("continue");
  });

  it("labels status as stale once it is older than the freshness window", async () => {
    const ports = createInMemoryPorts({
      script: [{ purpose: "status", final: BOB_STATUS_RESULT }],
      now: new Date("2026-08-28T02:30:00.000Z"),
    });
    const result = await executeToolCall(call("relay_ask_status", args), context(), ports);
    if (result.kind !== "artifact") throw new Error("expected an artifact");
    expect(result.entry.payload.stale).toBe(true);
  });

  it("escalates when the recipient's output does not match its schema", async () => {
    const ports = createInMemoryPorts({
      script: [{ purpose: "status", final: { publicSummary: "hi" } }],
    });
    const result = await executeToolCall(call("relay_ask_status", args), context(), ports);
    expect(result).toMatchObject({ kind: "escalate", code: "INVALID_AGENT_OUTPUT" });
  });

  it("refuses an Agent asking itself for status", async () => {
    const ports = createInMemoryPorts();
    const selfIntent = {
      intentId: "intent_alice_self",
      ownerId: "alice",
      agentId: "alice-agent",
      interfaces: [],
      dependencies: [],
    } as unknown as DispatchContext["activeIntents"][number];
    const result = await executeToolCall(
      call("relay_ask_status", { ...args, targetIntentId: "intent_alice_self" }),
      context({ activeIntents: [selfIntent] }),
      ports,
    );
    expect(result).toMatchObject({ kind: "denied" });
  });
});

/* ========================================================================== *
 * Replies cannot expand scope
 * ========================================================================== */

describe("relay_reply", () => {
  const pending = {
    requestId: "req_ctx_01",
    recipientOwnerId: "bob",
    recipientAgentId: "bob-agent",
    version: 2,
    expiresAt: "2026-08-28T02:15:00.000Z",
    purpose: "Implement Google OAuth",
  };
  const bob = { ownerId: "bob", agentId: "bob-agent" };

  it("inherits recipient, version and expiry from the original request", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call(
        "relay_reply",
        {
          replyToRequestId: "req_ctx_01",
          responseKind: "clarification",
          body: { summary: "here is the status" },
        },
        ALLOW_METADATA,
        bob,
      ),
      context({ pendingRequest: pending }),
      ports,
    );

    expect(result.kind).toBe("artifact");
    if (result.kind !== "artifact") return;
    expect(result.entry.payload.version).toBe(2);
    expect(result.entry.payload.expiresAt).toBe(pending.expiresAt);
    expect(result.entry.payload.recipientAgentId).toBe("bob-agent");
  });

  it("refuses a reply from anyone but the recipient", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call("relay_reply", {
        replyToRequestId: "req_ctx_01",
        responseKind: "clarification",
        body: { summary: "not mine to answer" },
      }),
      context({ pendingRequest: pending }),
      ports,
    );
    expect(result).toMatchObject({ kind: "denied" });
  });

  it("refuses a reply that targets a different request", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call(
        "relay_reply",
        {
          replyToRequestId: "req_other",
          responseKind: "clarification",
          body: { summary: "wrong request" },
        },
        ALLOW_METADATA,
        bob,
      ),
      context({ pendingRequest: pending }),
      ports,
    );
    expect(result).toMatchObject({ kind: "denied" });
  });
});

/* ========================================================================== *
 * Replan and completion
 * ========================================================================== */

describe("relay_propose_replan", () => {
  const args = {
    dependencyChangeId: "dep_01",
    originalSteps: ["Create a session after the OAuth callback"],
    revisedSteps: [
      "Extract deviceId from the validated request context",
      "Pass deviceId to SessionRepository.create",
    ],
    affectedFiles: ["src/routes/oauth-callback.ts", "tests/auth/oauth.test.ts"],
  };

  it("accepts a revision inside Alice's ownership and marks the agreement preserved", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call("relay_propose_replan", args),
      context({ activeAgreement: agreement }),
      ports,
    );
    expect(result.kind).toBe("artifact");
    if (result.kind !== "artifact") return;
    expect(result.entry.type).toBe("plan_diff");
    expect(result.entry.payload.agreementPreserved).toBe(true);
  });

  it("rejects a revision that claims a Bob-owned file", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call("relay_propose_replan", {
        ...args,
        affectedFiles: [...args.affectedFiles, "src/auth/session-repository.ts"],
      }),
      context({ activeAgreement: agreement }),
      ports,
    );
    expect(result).toMatchObject({ kind: "denied", code: "OWNERSHIP_VIOLATION" });
  });
});

describe("relay_complete_task", () => {
  const args = {
    tests: [{ command: "npm test", status: "passed" as const, summary: "9 passed" }],
    changedFiles: ["src/routes/oauth-callback.ts"],
    checkpointCommit: "af31d4e",
  };

  it("checkpoints when the diff stays inside Alice's ownership", async () => {
    const ports = createInMemoryPorts({
      gitResponses: {
        status: { stdout: "M  src/routes/oauth-callback.ts\0M  tests/auth/oauth.test.ts\0" },
        "rev-parse": { stdout: "cafe1234567890abcdef1234567890abcdef1234\n" },
      },
    });

    const result = await executeToolCall(
      call("relay_complete_task", args),
      context({ activeAgreement: agreement }),
      ports,
    );

    expect(result.kind).toBe("artifact");
    if (result.kind !== "artifact") return;
    expect(result.entry.payload.checkpointCommit).toBe("cafe123");
  });

  it("rejects the checkpoint when the diff crosses into Bob's files", async () => {
    const ports = createInMemoryPorts({
      gitResponses: {
        status: { stdout: "M  src/auth/session-repository.ts\0" },
        "rev-parse": { stdout: "cafe1234567890abcdef1234567890abcdef1234\n" },
      },
    });

    const result = await executeToolCall(
      call("relay_complete_task", args),
      context({ activeAgreement: agreement }),
      ports,
    );

    expect(result).toMatchObject({ kind: "escalate", code: "OWNERSHIP_VIOLATION" });
    // And crucially: no commit was created.
    expect(ports.gitCommands.some((command) => command.includes("commit"))).toBe(false);
  });

  it("completes with an empty diff rather than creating an empty commit", async () => {
    const ports = createInMemoryPorts({
      gitResponses: {
        status: { stdout: "" },
        "rev-parse": { stdout: "cafe1234567890abcdef1234567890abcdef1234\n" },
      },
    });

    const result = await executeToolCall(
      call("relay_complete_task", { ...args, changedFiles: [] }),
      context({ activeAgreement: agreement }),
      ports,
    );

    expect(result.kind).toBe("artifact");
    if (result.kind !== "artifact") return;
    expect(result.entry.payload.changedFiles).toEqual([]);
    expect(result.entry.payload.checkpointCommit).toBe("cafe123");
    // Nothing was staged or committed for a clean tree.
    expect(ports.gitCommands.some((command) => command.includes("commit"))).toBe(false);
    expect(ports.gitCommands.some((command) => command.includes("add"))).toBe(false);
  });

  it("refuses completion when tests did not pass", async () => {
    const ports = createInMemoryPorts();
    const result = await executeToolCall(
      call("relay_complete_task", {
        ...args,
        tests: [{ command: "npm test", status: "failed" as const, summary: "1 failed" }],
      }),
      context({ activeAgreement: agreement }),
      ports,
    );
    expect(result).toMatchObject({ kind: "denied" });
  });
});
