import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  emptyTelagentDatabase,
  JsonStore,
  nextTelagentEventSequence,
} from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ),
  );
});

describe("JsonStore", () => {
  it("loads an old version-1 database with an empty Telagent shape", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    const legacyDatabase = {
      version: 1,
      agents: [
        {
          id: "agent-1",
          name: "Existing Agent",
          description: "preserve me",
          instructions: "",
          status: "ready",
          workspacePath: "/workspace",
          codexThreadId: null,
          lastError: null,
          createdAt: "2026-08-28T00:00:00.000Z",
          updatedAt: "2026-08-28T00:00:00.000Z",
        },
      ],
      messages: [],
      runs: [],
    };
    await writeFile(databasePath, JSON.stringify(legacyDatabase), "utf8");

    const store = new JsonStore(databasePath);
    await store.initialize();

    expect(store.snapshot()).toEqual({
      ...legacyDatabase,
      telagent: emptyTelagentDatabase(),
    });
  });

  it("normalizes missing Telagent collections without dropping existing data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 1,
        agents: [],
        messages: [],
        runs: [],
        futureTopLevelField: { preserve: true },
        telagent: {
          projects: [{ projectId: "phoenix" }],
          futureTelagentCollection: [{ preserve: true }],
        },
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();

    expect(store.snapshot().telagent.projects).toEqual([
      { projectId: "phoenix" },
    ]);
    expect(store.snapshot().telagent.operations).toEqual([]);
    expect(store.snapshot().telagent.idempotencyRecords).toEqual([]);
    expect(store.snapshot().futureTopLevelField).toEqual({ preserve: true });
    expect(store.snapshot().telagent.futureTelagentCollection).toEqual([
      { preserve: true },
    ]);

    await store.mutate(() => undefined);
    const persisted = JSON.parse(await readFile(databasePath, "utf8")) as {
      futureTopLevelField: unknown;
      telagent: { futureTelagentCollection: unknown };
    };
    expect(persisted.futureTopLevelField).toEqual({ preserve: true });
    expect(persisted.telagent.futureTelagentCollection).toEqual([
      { preserve: true },
    ]);
  });

  it("rejects a malformed known Telagent collection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 1,
        agents: [],
        messages: [],
        runs: [],
        telagent: { operations: "not-an-array" },
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await expect(store.initialize()).rejects.toThrow(
      "Unsupported Telagent database collection: operations",
    );
  });

  it("allocates globally monotonic event sequences under concurrent mutations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    const store = new JsonStore(databasePath);
    await store.initialize();

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.mutate((database) => {
          const sequence = nextTelagentEventSequence(database);
          database.telagent.events.push({
            eventId: `event-${index}`,
            projectId: index % 2 === 0 ? "phoenix" : "another-project",
            sequence,
          });
        }),
      ),
    );

    const sequences = store
      .snapshot()
      .telagent.events.map((event) => (event as { sequence: number }).sequence);
    expect(sequences).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));

    const persisted = JSON.parse(await readFile(databasePath, "utf8")) as {
      telagent: { events: Array<{ sequence: number }> };
    };
    expect(persisted.telagent.events.map((event) => event.sequence)).toEqual(
      sequences,
    );
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});
