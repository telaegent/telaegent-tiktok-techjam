import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
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
  // Added after the first registry format shipped. Optional keeps existing
  // local records readable; those records retire under the conservative
  // legacy window below instead of living forever.
  taskExpiresAt: z.string().datetime().optional(),
});

const fileSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(entrySchema).max(10_000),
});
const MAX_REGISTRY_ENTRIES = 10_000;
const LEGACY_ENTRY_RETENTION_MS = 24 * 60 * 60 * 1_000;

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
  mint(
    taskId: string,
    canonicalPath: string,
    taskExpiresAt?: string,
  ): Promise<string>;
  /** Returns the local path for an identifier, or null if this task never held it. */
  resolve(taskId: string, resourceId: string): Promise<string | null>;
  /** Removes every local handle when its cloud task has durably ended. */
  removeTask(taskId: string): Promise<void>;
  /** Removes records whose recorded task lifetime or compatibility ceiling elapsed. */
  pruneExpired(now?: Date): Promise<number>;
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

  async mint(
    taskId: string,
    canonicalPath: string,
    taskExpiresAt?: string,
  ): Promise<string> {
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
      ...(taskExpiresAt ? { taskExpiresAt: parseExpiry(taskExpiresAt) } : {}),
    });
    return resourceId;
  }

  async resolve(taskId: string, resourceId: string): Promise<string | null> {
    const entry = this.entries.find(
      (candidate) => candidate.taskId === taskId && candidate.resourceId === resourceId,
    );
    return entry?.canonicalPath ?? null;
  }

  async removeTask(taskId: string): Promise<void> {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (this.entries[index]?.taskId === taskId) this.entries.splice(index, 1);
    }
  }

  async pruneExpired(now: Date = this.now()): Promise<number> {
    const before = this.entries.length;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (isExpired(this.entries[index]!, now)) this.entries.splice(index, 1);
    }
    return before - this.entries.length;
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
  private legacyImport: Promise<void> | undefined;
  private readonly entriesDirectory: string;
  private readonly byKeyDirectory: string;
  private readonly byResourceDirectory: string;
  private readonly legacyImportMarker: string;

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
    private readonly maximumEntries: number = MAX_REGISTRY_ENTRIES,
  ) {
    if (!path.isAbsolute(filePath)) {
      throw new Error("Resource registry path must be absolute");
    }
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > MAX_REGISTRY_ENTRIES) {
      throw new Error("Resource registry capacity is invalid");
    }
    // The original implementation used one JSON read/modify/write file. Keep
    // that path as a read-only migration source and put immutable records next
    // to it. Atomic hard links install records without overwriting a winner,
    // which is the cross-process compare-and-set primitive Node exposes on all
    // supported local filesystems.
    this.entriesDirectory = `${filePath}.entries`;
    this.byKeyDirectory = path.join(this.entriesDirectory, "by-key");
    this.byResourceDirectory = path.join(this.entriesDirectory, "by-resource");
    this.legacyImportMarker = path.join(this.entriesDirectory, ".legacy-imported");
  }

  mint(
    taskId: string,
    canonicalPath: string,
    taskExpiresAt?: string,
  ): Promise<string> {
    // Serialized so two concurrent approvals for one path cannot each mint an
    // identifier and leave the loser's grant pointing at a forgotten entry.
    return this.enqueue(async () => {
      await this.ensureReady();
      const resolved = path.resolve(canonicalPath);
      const existing = await this.readByKey(taskId, resolved);
      if (existing) return existing.resourceId;
      // Refuse the new mapping before writing. Persisting 10,001 entries would
      // create a file our own read schema rejects and turn one capacity event
      // into permanent registry corruption.
      if ((await this.entryCount()) >= this.maximumEntries) {
        throw new Error("Resource registry capacity exceeded");
      }
      const proposed: ResourceRegistryEntry = {
        taskId,
        resourceId: mintResourceId(),
        canonicalPath: resolved,
        issuedAt: this.now().toISOString(),
        ...(taskExpiresAt ? { taskExpiresAt: parseExpiry(taskExpiresAt) } : {}),
      };
      const persisted = await this.install(proposed);
      return persisted.resourceId;
    });
  }

  resolve(taskId: string, resourceId: string): Promise<string | null> {
    return this.enqueue(async () => {
      await this.ensureReady();
      if (!resourceIdSchema.safeParse(resourceId).success) return null;
      const entry = await this.readEntry(
        path.join(this.byResourceDirectory, `${resourceId}.json`),
        true,
      );
      if (entry && entry.resourceId !== resourceId) {
        throw new Error("Resource registry is unreadable");
      }
      return entry?.taskId === taskId ? entry.canonicalPath : null;
    });
  }

  removeTask(taskId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureReady();
      for (const filename of await this.entryFilenames()) {
        const keyPath = path.join(this.byKeyDirectory, filename);
        const entry = await this.readEntry(keyPath, false);
        if (!entry || entry.taskId !== taskId) continue;
        await unlink(
          path.join(this.byResourceDirectory, `${entry.resourceId}.json`),
        ).catch(ignoreMissing);
        await unlink(keyPath).catch(ignoreMissing);
      }
    });
  }

  pruneExpired(now: Date = this.now()): Promise<number> {
    return this.enqueue(async () => {
      await this.ensureReady();
      let removed = 0;
      for (const filename of await this.entryFilenames()) {
        const keyPath = path.join(this.byKeyDirectory, filename);
        const entry = await this.readEntry(keyPath, false);
        if (!entry || !isExpired(entry, now)) continue;
        await unlink(
          path.join(this.byResourceDirectory, `${entry.resourceId}.json`),
        ).catch(ignoreMissing);
        await unlink(keyPath).catch(ignoreMissing);
        removed += 1;
      }
      return removed;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async ensureReady(): Promise<void> {
    await mkdir(this.byKeyDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.byResourceDirectory, { recursive: true, mode: 0o700 });
    this.legacyImport ??= this.importLegacyFile();
    await this.legacyImport;
  }

  private async importLegacyFile(): Promise<void> {
    try {
      await readFile(this.legacyImportMarker);
      await unlink(this.filePath).catch(ignoreMissing);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw new Error("Resource registry is unreadable");
      }
    }

    let entries: readonly ResourceRegistryEntry[];
    try {
      const parsed = fileSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
      entries = parsed.entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        await this.markLegacyImported();
        return;
      }
      throw new Error("Resource registry is unreadable");
    }
    for (const entry of entries) await this.install(entry);
    // Written only after every legacy mapping is durable. The old source is
    // then removed so task cleanup cannot leave a second stale path mapping
    // behind, while the marker prevents a later restart from re-importing it.
    await this.markLegacyImported();
    await unlink(this.filePath).catch(ignoreMissing);
  }

  private async markLegacyImported(): Promise<void> {
    try {
      const handle = await open(this.legacyImportMarker, "wx", 0o600);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }

  private async install(proposed: ResourceRegistryEntry): Promise<ResourceRegistryEntry> {
    const keyPath = this.keyPath(proposed.taskId, proposed.canonicalPath);
    const existing = await this.readEntry(keyPath, true);
    if (existing) {
      this.assertSameResource(existing, proposed.taskId, proposed.canonicalPath);
      await this.ensureAlias(existing, keyPath);
      return existing;
    }

    const temporary = path.join(
      this.entriesDirectory,
      `.entry-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    let writeFailure: unknown;
    try {
      await handle.writeFile(JSON.stringify(proposed), "utf8");
      await handle.sync();
    } catch (error) {
      writeFailure = error;
    } finally {
      await handle.close();
    }
    if (writeFailure !== undefined) {
      await unlink(temporary).catch(ignoreMissing);
      throw writeFailure;
    }

    try {
      await link(temporary, keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    } finally {
      await unlink(temporary).catch(ignoreMissing);
    }

    const persisted = await this.readEntry(keyPath, false);
    if (!persisted) throw new Error("Resource registry is unreadable");
    this.assertSameResource(persisted, proposed.taskId, proposed.canonicalPath);
    await this.ensureAlias(persisted, keyPath);
    return persisted;
  }

  private async ensureAlias(entry: ResourceRegistryEntry, keyPath: string): Promise<void> {
    const aliasPath = path.join(this.byResourceDirectory, `${entry.resourceId}.json`);
    try {
      await link(keyPath, aliasPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const aliased = await this.readEntry(aliasPath, false);
      if (!aliased || JSON.stringify(aliased) !== JSON.stringify(entry)) {
        throw new Error("Resource registry is unreadable");
      }
    }
  }

  private async readByKey(
    taskId: string,
    canonicalPath: string,
  ): Promise<ResourceRegistryEntry | null> {
    const entry = await this.readEntry(this.keyPath(taskId, canonicalPath), true);
    if (entry) this.assertSameResource(entry, taskId, canonicalPath);
    return entry;
  }

  private async readEntry(
    entryPath: string,
    missingIsNull: boolean,
  ): Promise<ResourceRegistryEntry | null> {
    try {
      return entrySchema.parse(JSON.parse(await readFile(entryPath, "utf8")));
    } catch (error) {
      if (missingIsNull && (error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      throw new Error("Resource registry is unreadable");
    }
  }

  private keyPath(taskId: string, canonicalPath: string): string {
    const key = createHash("sha256")
      .update(taskId)
      .update("\0")
      .update(canonicalPath)
      .digest("hex");
    return path.join(this.byKeyDirectory, `${key}.json`);
  }

  private assertSameResource(
    entry: ResourceRegistryEntry,
    taskId: string,
    canonicalPath: string,
  ): void {
    if (entry.taskId !== taskId || entry.canonicalPath !== canonicalPath) {
      throw new Error("Resource registry is unreadable");
    }
  }

  private async entryFilenames(): Promise<string[]> {
    return (await readdir(this.byKeyDirectory)).filter((name) =>
      /^[0-9a-f]{64}\.json$/.test(name),
    );
  }

  private async entryCount(): Promise<number> {
    return (await this.entryFilenames()).length;
  }
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
}

function parseExpiry(value: string): string {
  return z.string().datetime().parse(value);
}

function isExpired(entry: Readonly<ResourceRegistryEntry>, now: Date): boolean {
  const expiry = entry.taskExpiresAt
    ? Date.parse(entry.taskExpiresAt)
    : Date.parse(entry.issuedAt) + LEGACY_ENTRY_RETENTION_MS;
  return expiry <= now.getTime();
}
