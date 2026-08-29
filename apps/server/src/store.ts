import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

const telagentCollectionNames = [
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

type TelagentCollectionName = (typeof telagentCollectionNames)[number];

export type TelagentDatabase = Record<TelagentCollectionName, unknown[]> &
  Record<string, unknown>;

export type DatabaseWithTelagent = Omit<Database, "telagent"> & {
  telagent: TelagentDatabase;
} & Record<string, unknown>;

export const emptyTelagentDatabase = (): TelagentDatabase => ({
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

const emptyDatabase = (): DatabaseWithTelagent => ({
  version: 1,
  agents: [],
  messages: [],
  runs: [],
  telagent: emptyTelagentDatabase(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeTelagentDatabase = (value: unknown): TelagentDatabase => {
  if (value === undefined) return emptyTelagentDatabase();
  if (!isRecord(value)) throw new Error("Unsupported Telagent database format");

  const normalized: TelagentDatabase = {
    ...value,
    ...emptyTelagentDatabase(),
  };
  for (const name of telagentCollectionNames) {
    const collection = value[name];
    if (collection === undefined) continue;
    if (!Array.isArray(collection)) {
      throw new Error(`Unsupported Telagent database collection: ${name}`);
    }
    normalized[name] = collection;
  }
  return normalized;
};

const normalizeDatabase = (value: unknown): DatabaseWithTelagent => {
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
    telagent: normalizeTelagentDatabase(value.telagent),
  };
};

export function nextTelagentEventSequence(
  database: DatabaseWithTelagent,
): number {
  let maximum = 0;
  for (const candidate of database.telagent.events) {
    if (!isRecord(candidate)) continue;
    const sequence = candidate.sequence;
    if (typeof sequence === "number" && Number.isSafeInteger(sequence)) {
      maximum = Math.max(maximum, sequence);
    }
  }
  return maximum + 1;
}

export class JsonStore {
  private data: DatabaseWithTelagent = emptyDatabase();
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

  snapshot(): DatabaseWithTelagent {
    return structuredClone(this.data);
  }

  async mutate<T>(
    mutation: (database: DatabaseWithTelagent) => T | Promise<T>,
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

  private async persist(data: DatabaseWithTelagent = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
