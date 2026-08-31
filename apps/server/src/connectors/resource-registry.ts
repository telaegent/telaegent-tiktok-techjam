import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { RESOURCE_ID_PATTERN, resourceIdSchema } from "./resource-request.js";

// Re-exported from the leaf that also defines the request shape, so the
// identifier a connector mints and the identifier an agent may name are one
// definition rather than two that drift.
export { RESOURCE_ID_PATTERN, resourceIdSchema };

const entrySchema = z.strictObject({
  taskId: z.string().min(1).max(256),
  resourceId: resourceIdSchema,
  canonicalPath: z.string().min(1),
  issuedAt: z.string().datetime(),
});

const fileSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(entrySchema).max(10_000),
});

export type ResourceRegistryEntry = z.infer<typeof entrySchema>;

/**
 * Maps opaque resource identifiers to local canonical paths.
 *
 * The mapping is the reason a resource can cross the cloud at all: a peer names
 * an identifier it was given, never a path, and only the owning connector can
 * turn that identifier back into a file. Nothing in this module is ever
 * transmitted; only the identifier half of an entry leaves the machine.
 *
 * Entries are scoped by task because grants are. The same file reached through
 * two tasks is two unrelated identifiers, so an identifier leaked from one
 * collaboration cannot be replayed into another.
 */
export interface ResourceRegistry {
  /**
   * Returns the identifier for this task and path, minting one if needed.
   * Idempotent per pair so re-approving the same file does not fragment a task
   * into several identifiers for one path.
   */
  mint(taskId: string, canonicalPath: string): Promise<string>;
  /** Returns the local path for an identifier, or null if this task never held it. */
  resolve(taskId: string, resourceId: string): Promise<string | null>;
}

/**
 * Mints an unguessable identifier.
 *
 * Deliberately random rather than derived from the path. A derived identifier
 * would be a path oracle: anyone holding one could confirm a guessed filename
 * by recomputing it, which would leak the private repository layout the opaque
 * identifier exists to hide.
 */
function mintResourceId(): string {
  return `resource_${randomBytes(24).toString("base64url")}`;
}

export class InMemoryResourceRegistry implements ResourceRegistry {
  private readonly entries: ResourceRegistryEntry[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async mint(taskId: string, canonicalPath: string): Promise<string> {
    const resolved = path.resolve(canonicalPath);
    const existing = this.entries.find(
      (entry) => entry.taskId === taskId && entry.canonicalPath === resolved,
    );
    if (existing) return existing.resourceId;
    const resourceId = mintResourceId();
    this.entries.push({
      taskId,
      resourceId,
      canonicalPath: resolved,
      issuedAt: this.now().toISOString(),
    });
    return resourceId;
  }

  async resolve(taskId: string, resourceId: string): Promise<string | null> {
    const entry = this.entries.find(
      (candidate) => candidate.taskId === taskId && candidate.resourceId === resourceId,
    );
    return entry?.canonicalPath ?? null;
  }
}

/**
 * Registry persisted to the connector's own state directory.
 *
 * Survives a connector restart so a `task` mode grant keeps working for the
 * life of the task rather than silently degrading to a re-approval prompt.
 */
export class FileResourceRegistry implements ResourceRegistry {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!path.isAbsolute(filePath)) {
      throw new Error("Resource registry path must be absolute");
    }
  }

  mint(taskId: string, canonicalPath: string): Promise<string> {
    // Serialized so two concurrent approvals for one path cannot each mint an
    // identifier and leave the loser's grant pointing at a forgotten entry.
    return this.enqueue(async () => {
      const resolved = path.resolve(canonicalPath);
      const entries = await this.read();
      const existing = entries.find(
        (entry) => entry.taskId === taskId && entry.canonicalPath === resolved,
      );
      if (existing) return existing.resourceId;
      const resourceId = mintResourceId();
      entries.push({
        taskId,
        resourceId,
        canonicalPath: resolved,
        issuedAt: this.now().toISOString(),
      });
      await this.write(entries);
      return resourceId;
    });
  }

  resolve(taskId: string, resourceId: string): Promise<string | null> {
    return this.enqueue(async () => {
      const entries = await this.read();
      const entry = entries.find(
        (candidate) => candidate.taskId === taskId && candidate.resourceId === resourceId,
      );
      return entry?.canonicalPath ?? null;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async read(): Promise<ResourceRegistryEntry[]> {
    try {
      const parsed = fileSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
      return [...parsed.entries];
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      // A corrupt registry must not be treated as "no grants exist yet", which
      // would silently re-mint identifiers and orphan every live grant.
      throw new Error("Resource registry is unreadable");
    }
  }

  private async write(entries: readonly ResourceRegistryEntry[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, entries }), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}
