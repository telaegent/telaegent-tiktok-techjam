import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentService } from "../agent-service.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type {
  ConflictEvaluation,
  ConversationOrchestrator,
  ConversationWorkRequest,
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

class FakeOrchestrator implements ConversationOrchestrator {
  readonly calls: ConversationWorkRequest[] = [];

  async processMessage(request: ConversationWorkRequest) {
    this.calls.push(request);
    return {
      publicSummary: "Structured planning completed.",
      intent:
        request.agentId === "bob-agent"
          ? {
              task: "Migrate session storage to Redis",
              branch: "feature/redis-sessions",
              plannedFiles: ["src/auth/session.ts", "src/models/session.ts"],
              interfaces: ["Session"],
              dependencies: ["User"],
              planSteps: ["Implement Redis persistence"],
            }
          : {
              task: "Add Google OAuth",
              branch: "feature/google-oauth",
              plannedFiles: ["src/auth/oauth.ts", "src/routes/login.ts"],
              interfaces: ["Session", "POST /login"],
              dependencies: ["User", "Session"],
              planSteps: ["Implement OAuth routes"],
            },
    };
  }
}

class FakeConflictEvaluator implements IntentConflictEvaluator {
  evaluate(
    candidate: IntentForConflict,
    activeIntents: IntentForConflict[],
  ): ConflictEvaluation {
    if (
      activeIntents.some((intent) => intent.interfaces.includes("Session")) &&
      candidate.interfaces.includes("Session")
    ) {
      return {
        score: 5,
        signals: [
          { type: "same_interface", score: 4, value: "Session" },
          { type: "same_module", score: 1, value: "src/auth" },
        ],
      };
    }
    return { score: 0, signals: [] };
  }
}

const agentService = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("Telaegent routes", () => {
  it("returns 202 Operations while preserving existing Agent routes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telaegent-route-test-"));
    temporaryDirectories.push(root);
    const store = new JsonStore(path.join(root, "launchpad.json"));
    await store.initialize();
    const orchestrator = new FakeOrchestrator();
    const telaegent = new TelaegentService(
      store,
      orchestrator,
      new FakeConflictEvaluator(),
    );
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, telaegent);

    const initialized = await app.inject({
      method: "POST",
      url: "/api/telaegent/demo/initialize",
      payload: {},
    });
    expect(initialized.statusCode).toBe(201);

    const bobAccepted = await app.inject({
      method: "POST",
      url: "/api/telaegent/conversations/conv_phoenix_demo/messages",
      payload: {
        ownerId: "bob",
        agentId: "bob-agent",
        content: "Migrate session storage to Redis",
        idempotencyKey: "route-redis-v1",
      },
    });
    expect(bobAccepted.statusCode).toBe(202);
    const bobHandle = bobAccepted.json<{ operationId: string; pollUrl: string }>();
    await vi.waitFor(async () => {
      const operation = await app.inject({ method: "GET", url: bobHandle.pollUrl });
      expect(operation.json().operation.state).toBe("completed");
    });

    const accepted = await app.inject({
      method: "POST",
      url: "/api/telaegent/conversations/conv_phoenix_demo/messages",
      payload: {
        ownerId: "alice",
        agentId: "alice-agent",
        content: "Add Google OAuth",
        idempotencyKey: "route-oauth-v1",
        requestId: "req_route_01",
        correlationId: "corr_route_01",
      },
    });
    expect(accepted.statusCode).toBe(202);
    const handle = accepted.json<{
      operationId: string;
      pollUrl: string;
    }>();
    expect(handle.pollUrl).toBe(
      `/api/telaegent/operations/${handle.operationId}`,
    );
    expect(accepted.json().requestId).toBe("req_route_01");
    expect(accepted.json().correlationId).toBe("corr_route_01");

    await vi.waitFor(() => expect(orchestrator.calls).toHaveLength(2));
    await vi.waitFor(async () => {
      const operation = await app.inject({
        method: "GET",
        url: handle.pollUrl,
      });
      expect(operation.json().operation.state).toBe("completed");
    });

    const snapshot = await app.inject({
      method: "GET",
      url: "/api/telaegent/projects/phoenix/snapshot",
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().snapshot.entries).toHaveLength(7);
    expect(snapshot.json().snapshot.intents).toHaveLength(2);
    expect(snapshot.json().snapshot.coordinationRequests).toEqual([
      expect.objectContaining({
        state: "detected",
        conflict: expect.objectContaining({ score: 5 }),
      }),
    ]);

    const existingAgents = await app.inject({ method: "GET", url: "/api/agents" });
    expect(existingAgents.statusCode).toBe(200);
    expect(existingAgents.json()).toEqual({ agents: [] });
    await app.close();
  });

  it("validates IDs and returns a safe not-found response", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telaegent-route-test-"));
    temporaryDirectories.push(root);
    const store = new JsonStore(path.join(root, "launchpad.json"));
    await store.initialize();
    const telaegent = new TelaegentService(
      store,
      new FakeOrchestrator(),
      new FakeConflictEvaluator(),
    );
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService, telaegent);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/telaegent/projects/not%2Fsafe/snapshot",
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await app.inject({
      method: "GET",
      url: "/api/telaegent/projects/phoenix/snapshot",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Telaegent project not found" });
    await app.close();
  });
});
