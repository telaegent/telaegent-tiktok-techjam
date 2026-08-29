import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  emptyTelaegentDatabase,
  JsonStore,
  nextTelaegentEventSequence,
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
  it("loads an old version-1 database with an empty Telaegent shape", async () => {
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
      telaegent: emptyTelaegentDatabase(),
    });
  });

  it("normalizes missing Telaegent collections without dropping existing data", async () => {
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
        telaegent: {
          projects: [{ projectId: "phoenix" }],
          futureTelaegentCollection: [{ preserve: true }],
        },
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();

    expect(store.snapshot().telaegent.projects).toEqual([
      { projectId: "phoenix" },
    ]);
    expect(store.snapshot().telaegent.operations).toEqual([]);
    expect(store.snapshot().telaegent.idempotencyRecords).toEqual([]);
    expect(store.snapshot().futureTopLevelField).toEqual({ preserve: true });
    expect(store.snapshot().telaegent.futureTelaegentCollection).toEqual([
      { preserve: true },
    ]);

    await store.mutate(() => undefined);
    const persisted = JSON.parse(await readFile(databasePath, "utf8")) as {
      futureTopLevelField: unknown;
      telaegent: { futureTelaegentCollection: unknown };
    };
    expect(persisted.futureTopLevelField).toEqual({ preserve: true });
    expect(persisted.telaegent.futureTelaegentCollection).toEqual([
      { preserve: true },
    ]);
  });

  it("rejects a malformed known Telaegent collection", async () => {
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
        telaegent: { operations: "not-an-array" },
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await expect(store.initialize()).rejects.toThrow(
      "Unsupported Telaegent database collection: operations",
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
          const sequence = nextTelaegentEventSequence(database);
          database.telaegent.events.push({
            eventId: `event-${index}`,
            projectId: index % 2 === 0 ? "phoenix" : "another-project",
            sequence,
          });
        }),
      ),
    );

    const sequences = store
      .snapshot()
      .telaegent.events.map((event) => (event as { sequence: number }).sequence);
    expect(sequences).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));

    const persisted = JSON.parse(await readFile(databasePath, "utf8")) as {
      telaegent: { events: Array<{ sequence: number }> };
    };
    expect(persisted.telaegent.events.map((event) => event.sequence)).toEqual(
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
