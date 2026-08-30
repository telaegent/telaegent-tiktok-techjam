/**
 * THE CANONICAL FLOW, END TO END.
 *
 * Real filesystem, real Git, the real Phoenix fixture, deterministic fake
 * providers. Every stage that workstream #6 owns runs its actual code.
 *
 * Stages 4 and 7 now run Duy's real engines — `assessConflict` and the
 * agreement engine — rather than the local stubs this file used before they
 * landed. The only thing still standing in for a teammate is HTTP transport and
 * Operation state (Khoa's routes and service); when those land the wrapper
 * becomes `app.inject(...)` and these assertions do not change.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeToolCall } from "./tool-dispatcher.js";
import {
  applyBobContractChange,
  initializePhoenixWorkspace,
  phoenixFixtureRoot,
} from "./phoenix-fixture.js";
import { currentCommit, validateChangedPaths } from "./git-helper.js";
import { detectDependencyImpact } from "./dependency-impact.js";
import { assessConflict } from "./conflict-engine.js";
import { createAgreement, recordAgreementDecision } from "./agreement-engine.js";
import { createRealPorts, type RealTestPorts } from "./testing/fake-ports.js";
import {
  ALICE_INTENT_RESULT,
  ALICE_REPLAN_RESULT,
  BOB_CONTEXT_PACK_RESULT,
  BOB_INTENT_RESULT,
  FABRICATED_COMMIT,
  FABRICATED_SHA,
  BOB_STATUS_RESULT,
} from "./testing/fake-runners.js";
import type {
  ActiveAgreement,
  Agreement,
  ImpactIntentView,
  PermissionDecision,
  ResolvedSourceGrant,
} from "./contract.js";
import type { AuthorizedToolCall, DispatchContext, SafeConversationEntry } from "./ports.js";
import type { ContextPackDispatchContext } from "./tool-dispatcher.js";
import type { ValidationRequestState } from "./context-pack-validator.js";
import { normalizeRuleSet } from "./context-policy.js";

const SERVER_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE_ROOT = phoenixFixtureRoot(SERVER_ROOT);
const NOW = new Date("2026-08-28T02:00:00.000Z");

const ALLOW: PermissionDecision = {
  kind: "allow",
  permissionClass: "AUTO_METADATA",
  safeScope: {},
};

let root: string;
let ports: RealTestPorts;
let conversation: SafeConversationEntry[];
let auditTimeline: string[];

const record = (result: Awaited<ReturnType<typeof executeToolCall>>): void => {
  if (result.kind === "artifact") conversation.push(result.entry);
};

const dispatch = async (
  name: AuthorizedToolCall["name"],
  args: unknown,
  context: DispatchContext,
  options: {
    actor?: { ownerId: string; agentId: string };
    decision?: PermissionDecision;
  } = {},
) => {
  const result = await executeToolCall(
    {
      callId: "call_" + conversation.length,
      name,
      arguments: args,
      permissionDecision: options.decision ?? ALLOW,
      actor: options.actor ?? { ownerId: "alice", agentId: "alice-agent" },
      projectId: "phoenix",
      correlationId: "corr_demo",
    },
    context,
    ports,
  );
  record(result);
  return result;
};


/* ========================================================================== *
 * Setup
 * ========================================================================== */

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "telagent-e2e-"));
  conversation = [];
  auditTimeline = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const buildPorts = (script: Parameters<typeof createRealPorts>[0]["script"]) => {
  ports = createRealPorts({ temporaryRoot: root, script, now: NOW });
  const original = ports.auditHint;
  ports.auditHint = (event) => {
    auditTimeline.push(event.eventType);
    original(event);
  };
  return ports;
};

const seedWorkspace = async (agentId: string, ownerId: string, branch: string) => {
  const workspacePath = path.join(root, agentId);
  await ports.fs.mkdir(workspacePath);
  await ports.fs.writeFile(
    path.join(workspacePath, "AGENTS.md"),
    "# Platform-managed Agent instructions\n",
  );
  const result = await initializePhoenixWorkspace(
    { workspacePath, fixtureRoot: FIXTURE_ROOT, branch, ownerId, agentId },
    ports,
  );
  if (!result.ok) throw new Error("fixture init failed: " + result.safeReason);
  return result.value;
};

/* ========================================================================== *
 * The flow
 * ========================================================================== */

describe("the canonical Telagent flow", () => {
  it("runs all seventeen stages and produces a complete, safe audit trail", async () => {
    buildPorts([{ purpose: "status", final: BOB_STATUS_RESULT }]);

    /* 1 — initialize Phoenix, Alice and Bob ------------------------------- */
    const bobWorkspace = await seedWorkspace("phoenix-bob", "bob", "feature/redis-sessions");
    const aliceWorkspace = await seedWorkspace(
      "phoenix-alice",
      "alice",
      "feature/google-oauth",
    );
    expect(bobWorkspace.baseCommit).not.toBe("");
    expect(bobWorkspace.workspacePath).not.toBe(aliceWorkspace.workspacePath);

    const bobContext: DispatchContext = {
      conversationId: "conv_1",
      intentId: "intent_bob_redis",
      activeIntents: [],
      workspacePath: bobWorkspace.workspacePath,
      provider: "codex",
      exchangeNumber: 1,
    };
    const aliceContext: DispatchContext = {
      ...bobContext,
      intentId: "intent_alice_oauth",
      workspacePath: aliceWorkspace.workspacePath,
    };
    const bob = { ownerId: "bob", agentId: "bob-agent" };
    const alice = { ownerId: "alice", agentId: "alice-agent" };

    /* 2 — Bob publishes intent and progress ------------------------------- */
    const bobIntentArgs = {
      ...BOB_INTENT_RESULT.nextAction.arguments,
      baseCommit: bobWorkspace.baseCommit.slice(0, 7),
    };
    const bobIntent = await dispatch("relay_publish_intent", bobIntentArgs, bobContext, {
      actor: bob,
    });
    expect(bobIntent.kind).toBe("artifact");

    const bobProgress = await dispatch(
      "relay_update_progress",
      {
        changedFiles: ["src/auth/session.ts"],
        progress: 60,
        blockers: [],
        verifiedAt: "2026-08-28T01:59:30.000Z",
      },
      bobContext,
      { actor: bob },
    );
    expect(bobProgress.kind).toBe("artifact");

    /* 3 — Alice plans without writing conflicting code -------------------- */
    const aliceIntentArgs = {
      ...ALICE_INTENT_RESULT.nextAction.arguments,
      baseCommit: aliceWorkspace.baseCommit.slice(0, 7),
    };
    const aliceIntent = await dispatch("relay_publish_intent", aliceIntentArgs, aliceContext, {
      actor: alice,
    });
    expect(aliceIntent.kind).toBe("artifact");

    const intents = [
      makeIntent("intent_bob_redis", bob, bobIntentArgs),
      makeIntent("intent_alice_oauth", alice, aliceIntentArgs),
    ];

    /* 4 — deterministic blocking conflict, via Duy's engine ---------------- */
    const conflict = assessConflict(
      {
        intentId: intents[0]!.intentId,
        plannedFiles: intents[0]!.plannedFiles,
        changedFiles: intents[0]!.changedFiles,
        interfaces: intents[0]!.interfaces,
        baseCommit: intents[0]!.baseCommit,
      },
      {
        intentId: intents[1]!.intentId,
        plannedFiles: intents[1]!.plannedFiles,
        changedFiles: intents[1]!.changedFiles,
        interfaces: intents[1]!.interfaces,
        // Deliberately Bob's base commit, not Alice's.
        //
        // This assertion is about overlapping work — shared interface, shared
        // module — and divergent bases are orthogonal to it. Alice's and Bob's
        // workspaces are `git init`-ed independently, so identical trees get
        // different commit SHAs whenever the second ticks over between the two
        // initialisations. Under load that happened, `base_commit` contributed
        // +1, and the canonical 5 became 6 — a flake that failed
        // `npm run check` at random and looked like whatever change happened to
        // be in flight.
        //
        // The deeper fix is for both workspaces of one project to share a base
        // commit, which is what two real clones would do. Left as a fixture
        // follow-up rather than done here, because it touches setup every other
        // stage depends on. Divergent bases are covered on their own below.
        baseCommit: intents[0]!.baseCommit,
      },
    );
    // plan.md §14.1: shared `Session` interface (+4) and shared `src/auth`
    // module (+1) is the canonical blocking score of 5.
    expect(conflict.score).toBe(5);
    expect(conflict.level).toBe("blocking");
    expect(conflict.signals.map((signal) => signal.type).sort()).toEqual([
      "interface",
      "module",
    ]);

    // Divergent bases, asserted deliberately rather than arrived at by timing.
    const divergent = assessConflict(
      {
        intentId: intents[0]!.intentId,
        plannedFiles: intents[0]!.plannedFiles,
        changedFiles: intents[0]!.changedFiles,
        interfaces: intents[0]!.interfaces,
        baseCommit: "aaaaaaa",
      },
      {
        intentId: intents[1]!.intentId,
        plannedFiles: intents[1]!.plannedFiles,
        changedFiles: intents[1]!.changedFiles,
        interfaces: intents[1]!.interfaces,
        baseCommit: "bbbbbbb",
      },
    );
    expect(divergent.score).toBe(6);
    expect(divergent.signals.map((signal) => signal.type)).toContain("base_commit");

    /* 5 — bounded status from Bob's private session ------------------------ */
    const status = await dispatch(
      "relay_ask_status",
      { targetIntentId: "intent_bob_redis", purpose: "Shared Session contract" },
      { ...aliceContext, activeIntents: intents as never },
      { actor: alice },
    );
    expect(status.kind).toBe("artifact");
    if (status.kind !== "artifact") return;
    expect(status.entry.payload.progress).toBe(60);
    expect(status.entry.payload.stale).toBe(false);

    const statusRun = ports.runner.callsFor("status")[0];
    expect(statusRun?.sandboxMode).toBe("read-only");
    expect(statusRun?.networkMode).toBe("none");

    /* 6 — a resolution is proposed ---------------------------------------- */
    const proposal = await dispatch(
      "relay_suggest_resolution",
      {
        coordinationRequestId: "coord_01",
        conflictingIntentIds: ["intent_bob_redis", "intent_alice_oauth"],
        proposalVersion: 1,
        ownership: [
          {
            ownerId: "bob",
            agentId: "bob-agent",
            // NOTE FOR DUY: `ownershipAssignmentSchema.files` accepts only exact
            // relative paths, so `src/models/**` is refused. The ownership gate
            // supports `dir/**` prefixes; widening `filesSchema` to `pathRuleSchema`
            // for ownership would let a split be expressed as a scope rather than
            // an enumeration. Until then the demo lists files exactly.
            files: [
              "src/auth/session.ts",
              "src/auth/session-repository.ts",
              "src/auth/fake-session-repository.ts",
              "src/auth/redis-session-repository.ts",
              "src/models/session.ts",
              "src/models/user.ts",
              "tests/auth/session.test.ts",
            ],
            interfaces: ["Session", "SessionRepository"],
          },
          {
            ownerId: "alice",
            agentId: "alice-agent",
            files: [
              "src/auth/oauth.ts",
              "src/routes/login.ts",
              "src/routes/oauth-callback.ts",
              "tests/auth/oauth.test.ts",
            ],
            interfaces: ["POST /login", "GET /oauth/callback"],
          },
        ],
        dependencyLinks: [
          {
            consumerIntentId: "intent_alice_oauth",
            providerIntentId: "intent_bob_redis",
            interface: "SessionRepository",
          },
        ],
        requiredRules: ["Bob must publish any Session contract change."],
        rationale: "Bob already owns the store; Alice only needs the current contract.",
      },
      { ...aliceContext, activeIntents: intents as never },
      { actor: alice },
    );
    expect(proposal.kind).toBe("artifact");
    if (proposal.kind !== "artifact") return;
    expect(proposal.entry.payload.requiresApprovalFrom).toEqual(["alice", "bob"]);

    /* 7 — two separate approvals, via Duy's agreement engine ---------------- */
    const proposed = createAgreement({
      agreementId: "agr_01",
      projectId: "phoenix",
      conversationId: "conv_1",
      coordinationRequestId: "coord_01",
      participantOwnerIds: ["alice", "bob"],
      ownership: proposal.entry.payload.ownership as Agreement["ownership"],
      dependencyLinks: proposal.entry.payload.dependencyLinks as Agreement["dependencyLinks"],
      requiredRules: proposal.entry.payload.rules as string[],
      rationale: String(proposal.entry.payload.rationale ?? ""),
      createdAt: NOW.toISOString(),
    });
    expect(proposed.state).toBe("proposed");

    // One approval is not enough — the whole point of DUAL_OWNER_COMMITMENT.
    const afterAlice = recordAgreementDecision(
      proposed,
      { agreementId: "agr_01", ownerId: "alice", decision: "approve", targetVersion: 1 },
      NOW.toISOString(),
    );
    expect(afterAlice.state).toBe("proposed");

    const agreement: ActiveAgreement = recordAgreementDecision(
      afterAlice,
      { agreementId: "agr_01", ownerId: "bob", decision: "approve", targetVersion: 1 },
      NOW.toISOString(),
    );
    expect(agreement.state).toBe("active");

    /* 8 — Alice's constrained implementation ------------------------------ */
    const aliceImplements: DispatchContext = {
      ...aliceContext,
      activeIntents: intents as never,
      activeAgreement: agreement,
    };

    /* 9 — Alice requests permissioned context ----------------------------- */
    const contextRequest = await dispatch(
      "relay_request_context",
      {
        topic: "Redis session architecture",
        purpose: "Implement Google OAuth",
        requestedPaths: ["docs/architecture/**", "src/auth/**", "tests/auth/**"],
        persistence: "current-task-only",
      },
      aliceImplements,
      { actor: alice },
    );
    expect(contextRequest.kind).toBe("artifact");
    if (contextRequest.kind !== "artifact") return;
    expect(contextRequest.entry.type).toBe("permission_request");

    /* 10 — Bob approves exact paths (STUB: Khoa's decision route) ---------- */
    const bobHead = await currentCommit(bobWorkspace.workspacePath, ports.git);
    if (!bobHead.ok) throw new Error("expected a commit");

    const grant: ResolvedSourceGrant = {
      permissionClass: "RECIPIENT_SOURCE_APPROVAL",
      contextRequestId: "req_ctx_01",
      approvedPaths: ["docs/architecture/**", "src/auth/**", "tests/auth/**"],
      approvedByOwnerIds: ["bob"],
      targetVersion: 1,
      expiresAt: "2026-08-28T02:15:00.000Z",
      sourceCommit: bobHead.value,
      taskScope: "task:google-oauth",
    };

    /* 11 — isolated generation, validation, delivery ----------------------- */
    const approvedRulesResult = normalizeRuleSet(grant.approvedPaths);
    if (!approvedRulesResult.ok) throw new Error("approved rules must normalize");
    const approvedGrantRules = approvedRulesResult.value;

    const requestState: ValidationRequestState = {
      contextRequestId: "req_ctx_01",
      projectId: "phoenix",
      state: "generating",
      version: 1,
      currentVersion: 1,
      taskScope: "task:google-oauth",
      expiresAt: "2026-08-28T02:15:00.000Z",
      approvedRules: approvedGrantRules,
      sharedByAgentId: "bob-agent",
    };

    const packContext: ContextPackDispatchContext = {
      ...bobContext,
      activeIntents: intents as never,
      activeAgreement: agreement,
      contextRequest: requestState,
      sourceWorkspacePath: bobWorkspace.workspacePath,
      projectId: "phoenix",
      // Khoa passes the approval through; the dispatcher never loads it.
      sourceGrant: grant,
    };

    const pack = await dispatch(
      "relay_create_context_pack",
      { ...BOB_CONTEXT_PACK_RESULT, contextRequestId: "req_ctx_01", expiresAt: "2026-08-28T02:15:00.000Z" },
      packContext,
      { actor: bob, decision: ALLOW },
    );

    expect(pack.kind).toBe("artifact");
    if (pack.kind !== "artifact") return;
    const packPayload = pack.entry.payload as Record<string, unknown>;
    const sources = packPayload.sources as Array<{ path: string; commit: string }>;

    expect(sources.map((source) => source.path)).toEqual([
      "docs/architecture/auth.md",
      "src/auth/session-repository.ts",
    ]);
    // Trusted metadata replaced whatever the model claimed. Both of the values
    // below passed schema validation — only the manifest rejected them.
    expect(sources.every((source) => source.commit === bobHead.value)).toBe(true);
    expect(JSON.stringify(packPayload)).not.toContain(FABRICATED_COMMIT);
    expect(JSON.stringify(packPayload)).not.toContain(FABRICATED_SHA);

    // The pack was validated against a manifest built from the filesystem, and
    // the isolated workspace that produced it is gone. The run itself now
    // happens in Khoa's orchestrator against `contextPackRunOptions()`, whose
    // read-only / no-network / ephemeral pinning is asserted in
    // context-workspace.test.ts.
    const workspaceEvent = ports.audit.find(
      (event) => event.eventType === "context_workspace_created",
    );
    expect(workspaceEvent?.safePayload.fileCount).toBe(8);
    expect(pack.evidence?.sourceManifestDigest).toBe(workspaceEvent?.safePayload.manifestDigest);
    const leftBehind = await ports.fs.exists(ports.temporaryRoot);
    if (leftBehind) {
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(ports.temporaryRoot)).toEqual([]);
    }

    /* 12 — the forbidden request is denied before any file is opened ------- */
    const denied = await dispatch(
      "relay_request_context",
      {
        topic: "Environment configuration",
        purpose: "Implement Google OAuth",
        requestedPaths: [".env"],
        persistence: "current-task-only",
      },
      aliceImplements,
      { actor: alice },
    );
    expect(denied).toMatchObject({ kind: "denied", code: "FORBID_ENV_FILES" });

    // The file genuinely exists in Bob's workspace, and was never read.
    const bobEnv = path.join(bobWorkspace.workspacePath, ".env");
    expect(await ports.fs.exists(bobEnv)).toBe(true);
    expect(await readFile(bobEnv, "utf8")).toContain("SESSION_SECRET=");

    /* 13 — Bob changes the Session contract -------------------------------- */
    const contractChange = await applyBobContractChange(bobWorkspace.workspacePath, ports);
    expect(contractChange.ok).toBe(true);
    if (!contractChange.ok) return;

    const published = await dispatch(
      "relay_report_dependency_change",
      {
        interface: "Session",
        change: "SessionRepository.create now requires deviceId",
        sourcePath: "src/auth/session-repository.ts",
        commit: contractChange.value.commit.slice(0, 7),
      },
      { ...bobContext, activeIntents: intents as never, activeAgreement: agreement },
      { actor: bob },
    );
    expect(published.kind).toBe("artifact");
    if (published.kind !== "artifact") return;
    expect(published.entry.payload.impactedOwnerIds).toEqual(["alice"]);

    /* 14 — impact detection names Alice and nobody else --------------------- */
    const impact = detectDependencyImpact({
      change: {
        dependencyChangeId: "dep_01",
        intentId: "intent_bob_redis",
        ownerId: "bob",
        agentId: "bob-agent",
        interface: "Session",
        relatedInterfaces: ["SessionRepository"],
        change: "SessionRepository.create now requires deviceId",
        sourcePath: "src/auth/session-repository.ts",
        commit: contractChange.value.commit.slice(0, 7),
      },
      activeIntents: intents as never,
      agreement,
    });
    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.value.impacted.map((item) => item.ownerId)).toEqual(["alice"]);

    /* 15 — Alice's plan is revised, preserving the agreement ---------------- */
    const replan = await dispatch(
      "relay_propose_replan",
      {
        dependencyChangeId: "dep_01",
        originalSteps: ALICE_REPLAN_RESULT.originalPlan,
        revisedSteps: ALICE_REPLAN_RESULT.revisedPlan,
        affectedFiles: ALICE_REPLAN_RESULT.affectedFiles,
      },
      aliceImplements,
      { actor: alice },
    );
    expect(replan.kind).toBe("artifact");
    if (replan.kind !== "artifact") return;
    expect(replan.entry.payload.agreementPreserved).toBe(true);
    expect(replan.entry.payload.requiresApprovalFrom).toEqual(["alice"]);

    /* 16 — Alice implements inside her ownership and completes -------------- */
    const callbackPath = path.join(
      aliceWorkspace.workspacePath,
      "src/routes/oauth-callback.ts",
    );
    const callback = await readFile(callbackPath, "utf8");
    await ports.fs.writeFile(
      callbackPath,
      callback.replace(
        "const session = await sessions.startSession(user.id, request.deviceId);",
        'const session = await sessions.startSession(user.id, request.deviceId ?? "unknown-device");',
      ),
    );

    const completion = await dispatch(
      "relay_complete_task",
      {
        tests: [{ command: "npm test", status: "passed", summary: "9 passed" }],
        changedFiles: ["src/routes/oauth-callback.ts"],
        checkpointCommit: aliceWorkspace.baseCommit.slice(0, 7),
      },
      aliceImplements,
      { actor: alice },
    );

    expect(completion.kind).toBe("artifact");
    if (completion.kind !== "artifact") return;
    expect(completion.entry.payload.changedFiles).toEqual(["src/routes/oauth-callback.ts"]);
    expect(String(completion.entry.payload.checkpointCommit)).toHaveLength(7);

    /* 17 — the audit trail is complete and safe ----------------------------- */
    expect(auditTimeline).toEqual([
      "phoenix_workspace_initialized",
      "phoenix_workspace_initialized",
      "intent_published",
      // Bob's Agent claimed it had changed src/auth/session.ts; Git says the
      // tree is clean at that point. Git wins and the disagreement becomes an
      // audit fact rather than accepted evidence (finding C9).
      "changed_files_mismatch",
      "intent_published",
      "context_workspace_created",
      "context_pack_validated",
    ]);

    const bobProgressEntry = conversation[1];
    expect(bobProgressEntry?.payload.reportMatchedGit).toBe(false);
    expect(bobProgressEntry?.payload.changedFiles).toEqual([]);

    const serialized = JSON.stringify(conversation);
    // No runtime prompt, no provider session, no secret, no denied content.
    expect(serialized).not.toContain("SESSION_SECRET");
    expect(serialized).not.toContain("phoenix-demo-client-secret");
    expect(serialized).not.toContain("runtimePrompt");
    expect(serialized).not.toContain("sessionId");
    expect(serialized).not.toContain(root); // no absolute local paths
    expect(serialized).not.toContain("claimed-by-model");

    // Every stage produced a visible entry.
    expect(conversation.map((item) => item.type)).toEqual([
      "tool_result", // Bob intent
      "tool_result", // Bob progress
      "tool_result", // Alice intent
      "tool_result", // Bob status
      "tool_call", // proposal
      "permission_request", // context request
      "context_pack", // validated pack
      "dependency_change",
      "plan_diff",
      "tool_result", // completion
    ]);
  }, 60_000);
});

describe("failure evidence the demo must also show", () => {
  it("rejects a checkpoint when Alice's diff crosses into Bob's files", async () => {
    buildPorts([]);
    const aliceWorkspace = await seedWorkspace(
      "phoenix-alice",
      "alice",
      "feature/google-oauth",
    );

    const repositoryPath = path.join(
      aliceWorkspace.workspacePath,
      "src/auth/session-repository.ts",
    );
    const original = await readFile(repositoryPath, "utf8");
    await ports.fs.writeFile(repositoryPath, original + "\n// Alice should not be here\n");

    const agreement = demoAgreement();
    const result = await executeToolCall(
      {
        callId: "call_x",
        name: "relay_complete_task",
        arguments: {
          tests: [{ command: "npm test", status: "passed", summary: "9 passed" }],
          changedFiles: [],
          checkpointCommit: "af31d4e",
        },
        permissionDecision: ALLOW,
        actor: { ownerId: "alice", agentId: "alice-agent" },
        projectId: "phoenix",
        correlationId: "corr_demo",
      },
      {
        conversationId: "conv_1",
        intentId: "intent_alice_oauth",
        activeIntents: [],
        workspacePath: aliceWorkspace.workspacePath,
        provider: "codex",
        exchangeNumber: 1,
        activeAgreement: agreement,
      },
      ports,
    );

    expect(result).toMatchObject({ kind: "escalate", code: "OWNERSHIP_VIOLATION" });

    // Nothing was committed: the working tree is still dirty.
    const status = await ports.git(["status", "--porcelain"], aliceWorkspace.workspacePath);
    expect(status.stdout).toContain("session-repository.ts");
  }, 30_000);

  it("rejects a pack that cites a source it was never given", async () => {
    buildPorts([
      {
        purpose: "create_context_pack",
        final: {
          ...BOB_CONTEXT_PACK_RESULT,
          sources: [{ path: "src/routes/login.ts" }],
        },
      },
    ]);
    const bobWorkspace = await seedWorkspace("phoenix-bob", "bob", "feature/redis-sessions");
    const head = await currentCommit(bobWorkspace.workspacePath, ports.git);
    if (!head.ok) throw new Error("expected a commit");

    const grant: ResolvedSourceGrant = {
      permissionClass: "RECIPIENT_SOURCE_APPROVAL",
      contextRequestId: "req_ctx_01",
      approvedPaths: ["docs/architecture/**", "src/auth/**"],
      approvedByOwnerIds: ["bob"],
      targetVersion: 1,
      expiresAt: "2026-08-28T02:15:00.000Z",
      sourceCommit: head.value,
      taskScope: "task:google-oauth",
    };
    const normalized = normalizeRuleSet(grant.approvedPaths);

    const result = await executeToolCall(
      {
        callId: "call_pack",
        name: "relay_create_context_pack",
        arguments: {
          ...BOB_CONTEXT_PACK_RESULT,
          contextRequestId: "req_ctx_01",
          expiresAt: "2026-08-28T02:15:00.000Z",
          sources: [{ path: "src/routes/login.ts", commit: "af31d4e", sha256: "c".repeat(64) }],
        },
        permissionDecision: ALLOW,
        actor: { ownerId: "bob", agentId: "bob-agent" },
        projectId: "phoenix",
        correlationId: "corr_demo",
      },
      {
        conversationId: "conv_1",
        activeIntents: [],
        workspacePath: bobWorkspace.workspacePath,
        provider: "codex",
        exchangeNumber: 1,
        contextRequest: {
          contextRequestId: "req_ctx_01",
          projectId: "phoenix",
          state: "generating",
          version: 1,
          currentVersion: 1,
          taskScope: "task:google-oauth",
          expiresAt: "2026-08-28T02:15:00.000Z",
          approvedRules: normalized.ok ? normalized.value : [],
          sharedByAgentId: "bob-agent",
        },
        sourceWorkspacePath: bobWorkspace.workspacePath,
        projectId: "phoenix",
        sourceGrant: grant,
      } as ContextPackDispatchContext,
      ports,
    );

    expect(result).toMatchObject({ kind: "denied", code: "FORBID_UNAPPROVED_PATH" });
    // The rejected candidate body is not returned anywhere.
    expect(JSON.stringify(result)).not.toContain("SessionRepository and stored in Redis");
  }, 30_000);
});

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

function makeIntent(
  intentId: string,
  actor: { ownerId: string; agentId: string },
  args: {
    task: string;
    branch: string;
    baseCommit: string;
    plannedFiles: string[];
    interfaces: string[];
    dependencies: string[];
    plan: string[];
  },
): ImpactIntentView & {
  plannedFiles: string[];
  changedFiles: string[];
  baseCommit: string;
} {
  return {
    intentId,
    agentId: actor.agentId,
    ownerId: actor.ownerId,
    interfaces: args.interfaces,
    dependencies: args.dependencies,
    plannedFiles: args.plannedFiles,
    changedFiles: [],
    baseCommit: args.baseCommit,
  };
}


function demoAgreement(): ActiveAgreement {
  return {
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
        files: ["src/auth/session-repository.ts", "src/models/**"],
        interfaces: ["Session"],
      },
    ],
    dependencyLinks: [],
    requiredRules: [],
  };
}
