import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonStore } from "../store.js";
import type {
  ConflictEvaluation,
  ConversationOrchestrator,
  ConversationWorkRequest,
  ConversationWorkResult,
  IntentCandidate,
  IntentConflictEvaluator,
  IntentForConflict,
} from "./conversation-orchestrator.js";
import { TelaegentService } from "./service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ),
  );
});

class DeferredOrchestrator implements ConversationOrchestrator {
  readonly calls: ConversationWorkRequest[] = [];
  private readonly pending: Array<{
    resolve: (result: ConversationWorkResult) => void;
    reject: (error: Error) => void;
  }> = [];

  processMessage(request: ConversationWorkRequest): Promise<ConversationWorkResult> {
    this.calls.push(request);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  resolve(summary: string, intent: IntentCandidate = aliceIntent): void {
    const pending = this.pending.shift();
    if (!pending) throw new Error("No pending orchestration call");
    pending.resolve({ publicSummary: summary, intent });
  }

  reject(error: Error): void {
    const pending = this.pending.shift();
    if (!pending) throw new Error("No pending orchestration call");
    pending.reject(error);
  }
}

class CanonicalConflictEvaluator implements IntentConflictEvaluator {
  evaluate(
    candidate: IntentForConflict,
    activeIntents: IntentForConflict[],
  ): ConflictEvaluation {
    const other = activeIntents[0];
    if (!other) return { score: 0, signals: [] };
    const signals: ConflictEvaluation["signals"] = [];
    const sharedInterface = candidate.interfaces.find((name) =>
      other.interfaces.some(
        (otherName) => otherName.toLowerCase() === name.toLowerCase(),
      ),
    );
    if (sharedInterface) {
      signals.push({ type: "same_interface", score: 4, value: sharedInterface });
    }
    const candidateModules = new Set(
      candidate.plannedFiles.map((file) => file.split("/").slice(0, 2).join("/")),
    );
    const sharedModule = other.plannedFiles
      .map((file) => file.split("/").slice(0, 2).join("/"))
      .find((module) => candidateModules.has(module));
    if (sharedModule) {
      signals.push({ type: "same_module", score: 1, value: sharedModule });
    }
    return {
      score: signals.reduce((total, signal) => total + signal.score, 0),
      signals,
    };
  }
}

class MismatchedConflictEvaluator implements IntentConflictEvaluator {
  evaluate(
    _candidate: IntentForConflict,
    activeIntents: IntentForConflict[],
  ): ConflictEvaluation {
    return activeIntents.length === 0
      ? { score: 0, signals: [] }
      : {
          score: 5,
          signals: [{ type: "same_interface", score: 4, value: "Session" }],
        };
  }
}

const bobIntent: IntentCandidate = {
  task: "Migrate session storage to Redis",
  branch: "feature/redis-sessions",
  plannedFiles: ["src/auth/session.ts", "src/models/session.ts"],
  interfaces: ["Session"],
  dependencies: ["User"],
  planSteps: ["Implement Redis-backed session persistence"],
};

const aliceIntent: IntentCandidate = {
  task: "Add Google OAuth",
  branch: "feature/google-oauth",
  plannedFiles: ["src/auth/oauth.ts", "src/routes/login.ts"],
  interfaces: ["Session", "POST /login", "GET /oauth/callback"],
  dependencies: ["User", "Session"],
  planSteps: ["Add OAuth routes", "Handle the provider callback"],
};

const createStore = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telaegent-service-test-"));
  temporaryDirectories.push(root);
  const databasePath = path.join(root, "launchpad.json");
  const store = new JsonStore(databasePath);
  await store.initialize();
  return { store, databasePath };
};

const submitInput = {
  conversationId: "conv_phoenix_demo",
  ownerId: "alice",
  agentId: "alice-agent",
  content: "Add Google OAuth",
  idempotencyKey: "alice-oauth-v1",
};

describe("TelaegentService", () => {
  it("initializes the demo idempotently and returns an ordered snapshot", async () => {
    const { store } = await createStore();
    const service = new TelaegentService(store, new DeferredOrchestrator());

    const first = await service.initializeDemo();
    const second = await service.initializeDemo();

    expect(first.project).toMatchObject({
      projectId: "phoenix",
      name: "Phoenix Web App",
    });
    expect(second.owners).toEqual([
      { ownerId: "alice", displayName: "Alice" },
      { ownerId: "bob", displayName: "Bob" },
    ]);
    expect(store.snapshot().telaegent.projects).toHaveLength(1);
    expect(store.snapshot().telaegent.conversations).toHaveLength(1);
    expect(store.snapshot().telaegent.events).toHaveLength(1);
  });

  it("returns an Operation immediately and deduplicates retries", async () => {
    const { store } = await createStore();
    const orchestrator = new DeferredOrchestrator();
    const service = new TelaegentService(
      store,
      orchestrator,
      new CanonicalConflictEvaluator(),
    );
    await service.initializeDemo();

    const [accepted, concurrentDuplicate] = await Promise.all([
      service.submitConversationMessage(submitInput),
      service.submitConversationMessage(submitInput),
    ]);
    expect(accepted.state).toBe("accepted");
    expect(concurrentDuplicate.operationId).toBe(accepted.operationId);

    await vi.waitFor(() => expect(orchestrator.calls).toHaveLength(1));
    await expect(
      service.submitConversationMessage({
        ...submitInput,
        idempotencyKey: "alice-second-operation-v1",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const duplicate = await service.submitConversationMessage(submitInput);
    expect(duplicate.operationId).toBe(accepted.operationId);
    expect(store.snapshot().telaegent.operations).toHaveLength(1);
    expect(store.snapshot().telaegent.conversationEntries).toHaveLength(1);

    orchestrator.resolve("OAuth planning is ready for conflict evaluation.");
    await vi.waitFor(() =>
      expect(service.getOperation(accepted.operationId).state).toBe("completed"),
    );

    const snapshot = service.getProjectSnapshot("phoenix");
    expect(snapshot.entries).toHaveLength(3);
    expect(snapshot.events.map((event) => (event as { sequence: number }).sequence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(snapshot.intents).toHaveLength(1);
  });

  it("publishes Bob and Alice intents and pauses Alice on a score-5 conflict", async () => {
    const { store } = await createStore();
    const orchestrator = new DeferredOrchestrator();
    const service = new TelaegentService(
      store,
      orchestrator,
      new CanonicalConflictEvaluator(),
    );
    await service.initializeDemo();

    const bob = await service.submitConversationMessage({
      ...submitInput,
      ownerId: "bob",
      agentId: "bob-agent",
      content: bobIntent.task,
      idempotencyKey: "bob-redis-v1",
    });
    await vi.waitFor(() => expect(orchestrator.calls).toHaveLength(1));
    orchestrator.resolve("Bob's session plan is ready.", bobIntent);
    await vi.waitFor(() =>
      expect(service.getOperation(bob.operationId).state).toBe("completed"),
    );

    const alice = await service.submitConversationMessage(submitInput);
    await vi.waitFor(() => expect(orchestrator.calls).toHaveLength(2));
    orchestrator.resolve("Alice's OAuth plan is ready.", aliceIntent);
    await vi.waitFor(() =>
      expect(service.getOperation(alice.operationId).state).toBe("completed"),
    );

    const snapshot = service.getProjectSnapshot("phoenix");
    expect(snapshot.intents).toHaveLength(2);
    expect(snapshot.intents[0]).toMatchObject({
      agentId: "bob-agent",
      status: "active",
      conflict: { score: 0, severity: "none" },
    });
    expect(snapshot.intents[1]).toMatchObject({
      agentId: "alice-agent",
      status: "coordination_required",
      conflict: { score: 5, severity: "likely_conflict" },
    });
    expect(snapshot.coordinationRequests).toHaveLength(1);
    expect(snapshot.coordinationRequests[0]).toMatchObject({
      state: "detected",
      version: 1,
      conflict: {
        score: 5,
        signals: [
          { type: "same_interface", score: 4, value: "Session" },
          { type: "same_module", score: 1, value: "src/auth" },
        ],
      },
    });
    expect(
      (snapshot.conversation as { updatedAt: string }).updatedAt,
    ).toBe((snapshot.intents[1] as { updatedAt: string }).updatedAt);
  });

  it("keeps unrelated intentions active without creating a false conflict", async () => {
    const { store } = await createStore();
    const orchestrator = new DeferredOrchestrator();
    const service = new TelaegentService(
      store,
      orchestrator,
      new CanonicalConflictEvaluator(),
    );
    await service.initializeDemo();
    const bob = await service.submitConversationMessage({
      ...submitInput,
      ownerId: "bob",
      agentId: "bob-agent",
      idempotencyKey: "unrelated-bob-v1",
    });
    await vi.waitFor(() => expect(orchestrator.calls).toHaveLength(1));
    orchestrator.resolve("Bob planning completed.", bobIntent);
    await vi.waitFor(() =>
      expect(service.getOperation(bob.operationId).state).toBe("completed"),
    );

    const unrelatedIntent: IntentCandidate = {
      task: "Add invoice export",
      branch: "feature/invoice-export",
      plannedFiles: ["src/billing/invoice-export.ts"],
      interfaces: ["InvoiceExporter"],
      dependencies: ["Invoice"],
      planSteps: ["Implement invoice export"],
    };
    const alice = await service.submitConversationMessage({
      ...submitInput,
      content: unrelatedIntent.task,
      idempotencyKey: "unrelated-alice-v1",
    });
    await vi.waitFor(() => expect(orchestrator.calls).toHaveLength(2));
    orchestrator.resolve("Alice planning completed.", unrelatedIntent);
    await vi.waitFor(() =>
      expect(service.getOperation(alice.operationId).state).toBe("completed"),
    );

    const snapshot = service.getProjectSnapshot("phoenix");
    expect(snapshot.intents).toHaveLength(2);
    expect(snapshot.intents[1]).toMatchObject({
      status: "active",
      conflict: { score: 0, severity: "none" },
    });
    expect(snapshot.coordinationRequests).toEqual([]);
  });

  it("rejects forbidden intent paths before publication", async () => {
    const { store, databasePath } = await createStore();
    const orchestrator = new DeferredOrchestrator();
    const service = new TelaegentService(
      store,
      orchestrator,
      new CanonicalConflictEvaluator(),
    );
    await service.initializeDemo();
    const accepted = await service.submitConversationMessage({
      ...submitInput,
      idempotencyKey: "forbidden-intent-path-v1",
    });
    await vi.waitFor(() => expect(orchestrator.calls).toHaveLength(1));
    orchestrator.resolve("Planning completed.", {
      ...aliceIntent,
      plannedFiles: ["config/.env"],
    });
    await vi.waitFor(() =>
      expect(service.getOperation(accepted.operationId).state).toBe("failed"),
    );

    expect(store.snapshot().telaegent.intents).toHaveLength(0);
    expect(await readFile(databasePath, "utf8")).not.toContain("config/.env");
  });

  it("rejects conflict scores that do not match deterministic evidence", async () => {
    const { store } = await createStore();
    const orchestrator = new DeferredOrchestrator();
    const service = new TelaegentService(
      store,
      orchestrator,
      new MismatchedConflictEvaluator(),
    );
    await service.initializeDemo();
    const bob = await service.submitConversationMessage({
      ...submitInput,
      ownerId: "bob",
      agentId: "bob-agent",
      idempotencyKey: "mismatch-bob-v1",
    });
    await vi.waitFor(() => expect(orchestrator.calls).toHaveLength(1));
    orchestrator.resolve("Bob planning completed.", bobIntent);
    await vi.waitFor(() =>
      expect(service.getOperation(bob.operationId).state).toBe("completed"),
    );

    const alice = await service.submitConversationMessage({
      ...submitInput,
      idempotencyKey: "mismatch-alice-v1",
    });
    await vi.waitFor(() => expect(orchestrator.calls).toHaveLength(2));
    orchestrator.resolve("Alice planning completed.", aliceIntent);
    await vi.waitFor(() =>
      expect(service.getOperation(alice.operationId).state).toBe("failed"),
    );

    expect(service.getProjectSnapshot("phoenix").intents).toHaveLength(1);
    expect(service.getProjectSnapshot("phoenix").coordinationRequests).toEqual([]);
  });

  it("minimizes untyped snapshot records and rejects an unknown owner", async () => {
    const { store } = await createStore();
    const service = new TelaegentService(store, new DeferredOrchestrator());
    await service.initializeDemo();
    await store.mutate((database) => {
      database.telaegent.intents.push({
        intentId: "intent-1",
        projectId: "phoenix",
        task: "Safe task",
        runtimePrompt: "must-not-leak",
        nested: { providerSessionId: "private-session", safe: true },
      });
    });

    expect(service.getProjectSnapshot("phoenix").intents).toEqual([
      {
        intentId: "intent-1",
        projectId: "phoenix",
        task: "Safe task",
        nested: { safe: true },
      },
    ]);
    await expect(
      service.submitConversationMessage({
        ...submitInput,
        ownerId: "mallory",
        idempotencyKey: "unknown-owner-v1",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.submitConversationMessage({
        ...submitInput,
        agentId: "bob-agent",
        idempotencyKey: "wrong-owner-agent-v1",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("stores a safe failure without persisting the raw runtime error", async () => {
    const { store, databasePath } = await createStore();
    const orchestrator = new DeferredOrchestrator();
    const service = new TelaegentService(store, orchestrator);
    await service.initializeDemo();
    const accepted = await service.submitConversationMessage({
      ...submitInput,
      idempotencyKey: "safe-failure-v1",
    });

    await vi.waitFor(() => expect(orchestrator.calls).toHaveLength(1));
    orchestrator.reject(new Error("secret-token-should-never-persist"));
    await vi.waitFor(() =>
      expect(service.getOperation(accepted.operationId).state).toBe("failed"),
    );

    expect(service.getOperation(accepted.operationId).safeError).toEqual({
      code: "BACKGROUND_WORK_FAILED",
      message: "The Telaegent background operation failed",
    });
    expect(await readFile(databasePath, "utf8")).not.toContain(
      "secret-token-should-never-persist",
    );
  });

  it("rejects secret-like shared content before it reaches persistence", async () => {
    const { store, databasePath } = await createStore();
    const service = new TelaegentService(store, new DeferredOrchestrator());
    await service.initializeDemo();

    await expect(
      service.submitConversationMessage({
        ...submitInput,
        content: "API_KEY=super-secret-value",
        idempotencyKey: "secret-message-v1",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(store.snapshot().telaegent.operations).toHaveLength(0);
    expect(await readFile(databasePath, "utf8")).not.toContain(
      "super-secret-value",
    );
  });

  it("rejects a secret-bearing Agent summary without persisting it", async () => {
    const { store, databasePath } = await createStore();
    const orchestrator = new DeferredOrchestrator();
    const service = new TelaegentService(store, orchestrator);
    await service.initializeDemo();
    const accepted = await service.submitConversationMessage({
      ...submitInput,
      idempotencyKey: "secret-summary-v1",
    });

    await vi.waitFor(() => expect(orchestrator.calls).toHaveLength(1));
    orchestrator.resolve("ACCESS_TOKEN=agent-secret-value");
    await vi.waitFor(() =>
      expect(service.getOperation(accepted.operationId).state).toBe("failed"),
    );
    expect(await readFile(databasePath, "utf8")).not.toContain(
      "agent-secret-value",
    );
  });

  it("fails interrupted Operations on restart but preserves waiting requests", async () => {
    const { store } = await createStore();
    const service = new TelaegentService(store, new DeferredOrchestrator());
    await service.initializeDemo();
    const base = {
      requestId: "request",
      correlationId: "correlation",
      projectId: "phoenix",
      conversationId: "conv_phoenix_demo",
      agentId: "alice-agent",
      ownerId: "alice",
      type: "submit_conversation_message",
      runId: null,
      safeError: null,
      result: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    await store.mutate((database) => {
      database.telaegent.operations.push(
        { ...base, operationId: "running-operation", state: "running" },
        {
          ...base,
          operationId: "waiting-operation",
          state: "waiting_for_recipient",
        },
      );
    });

    await service.reconcileOnStartup();

    expect(service.getOperation("running-operation")).toMatchObject({
      state: "failed",
      safeError: { code: "SERVER_RESTARTED" },
    });
    expect(service.getOperation("waiting-operation").state).toBe(
      "waiting_for_recipient",
    );
  });
});
