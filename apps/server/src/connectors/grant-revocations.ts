import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const revocationSchema = z.strictObject({
  grantId: z.string().uuid(),
  expiresAt: z.string().datetime().nullable(),
});
const snapshotSchema = z.strictObject({
  version: z.literal(1),
  revocations: z.array(revocationSchema).max(10_000),
});
export type CapabilityGrantRevocation = z.infer<typeof revocationSchema>;

export interface CapabilityGrantRevocationStore {
  record(revocations: readonly CapabilityGrantRevocation[], now?: Date): Promise<void>;
  isRevoked(grantId: string, now?: Date): Promise<boolean>;
}

export class InMemoryCapabilityGrantRevocationStore
  implements CapabilityGrantRevocationStore
{
  protected readonly revocations = new Map<string, string | null>();

  async record(revocations: readonly CapabilityGrantRevocation[], now = new Date()): Promise<void> {
    this.prune(now);
    for (const item of revocations) {
      const parsed = revocationSchema.parse(item);
      this.revocations.set(parsed.grantId, parsed.expiresAt);
    }
  }

  async isRevoked(grantId: string, now = new Date()): Promise<boolean> {
    this.prune(now);
    return this.revocations.has(z.string().uuid().parse(grantId));
  }

  protected prune(now: Date): void {
    for (const [grantId, expiresAt] of this.revocations) {
      if (expiresAt !== null && Date.parse(expiresAt) <= now.getTime()) {
        this.revocations.delete(grantId);
      }
    }
  }
}

/** Durable connector-local tombstones, scoped to one opaque runtime binding. */
export class FileCapabilityGrantRevocationStore
  extends InMemoryCapabilityGrantRevocationStore
{
  private loaded: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {
    super();
    if (!path.isAbsolute(filePath)) {
      throw new Error("Capability revocation store path must be absolute");
    }
  }

  override async record(
    revocations: readonly CapabilityGrantRevocation[],
    now = new Date(),
  ): Promise<void> {
    await this.ensureLoaded();
    await this.enqueue(async () => {
      await super.record(revocations, now);
      await this.persist();
    });
  }

  override async isRevoked(grantId: string, now = new Date()): Promise<boolean> {
    await this.ensureLoaded();
    return this.enqueue(() => super.isRevoked(grantId, now));
  }

  private async ensureLoaded(): Promise<void> {
    this.loaded ??= this.load();
    await this.loaded;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("Capability revocation store is unreadable");
    }
    if (Buffer.byteLength(raw) > 1_048_576) {
      throw new Error("Capability revocation store is unreadable");
    }
    const parsed = snapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("Capability revocation store is unreadable");
    await super.record(parsed.data.revocations);
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({
      version: 1,
      revocations: [...this.revocations].map(([grantId, expiresAt]) => ({
        grantId,
        expiresAt,
      })),
    } satisfies z.input<typeof snapshotSchema>);
    if (Buffer.byteLength(payload) > 1_048_576) {
      throw new Error("Capability revocation store capacity exceeded");
    }
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
