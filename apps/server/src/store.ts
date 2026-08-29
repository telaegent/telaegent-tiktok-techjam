import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

const telaegentCollectionNames = [
  "projects",
  "owners",
  "agentBindings",
  "conversations",
  "conversationEntries",
  "intents",
  "coordinationRequests",
  "agreements",
  "contextRequests",
  "contextPacks",
  "dependencyChanges",
  "planRevisions",
  "operations",
  "events",
  "idempotencyRecords",
] as const;

type TelaegentCollectionName = (typeof telaegentCollectionNames)[number];

export type TelaegentDatabase = Record<TelaegentCollectionName, unknown[]> &
  Record<string, unknown>;

export type DatabaseWithTelaegent = Omit<Database, "telaegent"> & {
  telaegent: TelaegentDatabase;
} & Record<string, unknown>;

export const emptyTelaegentDatabase = (): TelaegentDatabase => ({
  projects: [],
  owners: [],
  agentBindings: [],
  conversations: [],
  conversationEntries: [],
  intents: [],
  coordinationRequests: [],
  agreements: [],
  contextRequests: [],
  contextPacks: [],
  dependencyChanges: [],
  planRevisions: [],
  operations: [],
  events: [],
  idempotencyRecords: [],
});

const emptyDatabase = (): DatabaseWithTelaegent => ({
  version: 1,
  agents: [],
  messages: [],
  runs: [],
  telaegent: emptyTelaegentDatabase(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeTelaegentDatabase = (value: unknown): TelaegentDatabase => {
  if (value === undefined) return emptyTelaegentDatabase();
  if (!isRecord(value)) throw new Error("Unsupported Telaegent database format");

  const normalized: TelaegentDatabase = {
    ...value,
    ...emptyTelaegentDatabase(),
  };
  for (const name of telaegentCollectionNames) {
    const collection = value[name];
    if (collection === undefined) continue;
    if (!Array.isArray(collection)) {
      throw new Error(`Unsupported Telaegent database collection: ${name}`);
    }
    normalized[name] = collection;
  }
  return normalized;
};

const normalizeDatabase = (value: unknown): DatabaseWithTelaegent => {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Unsupported database format");
  }
  if (
    !Array.isArray(value.agents) ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.runs)
  ) {
    throw new Error("Unsupported database format");
  }
  return {
    ...value,
    version: 1,
    agents: value.agents as Database["agents"],
    messages: value.messages as Database["messages"],
    runs: value.runs as Database["runs"],
    telaegent: normalizeTelaegentDatabase(value.telaegent),
  };
};

export function nextTelaegentEventSequence(
  database: DatabaseWithTelaegent,
): number {
  let maximum = 0;
  for (const candidate of database.telaegent.events) {
    if (!isRecord(candidate)) continue;
    const sequence = candidate.sequence;
    if (typeof sequence === "number" && Number.isSafeInteger(sequence)) {
      maximum = Math.max(maximum, sequence);
    }
  }
  return maximum + 1;
}

export class JsonStore {
  private data: DatabaseWithTelaegent = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = normalizeDatabase(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): DatabaseWithTelaegent {
    return structuredClone(this.data);
  }

  async mutate<T>(
    mutation: (database: DatabaseWithTelaegent) => T | Promise<T>,
  ): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: DatabaseWithTelaegent = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
