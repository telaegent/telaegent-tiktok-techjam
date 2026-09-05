import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ResourcePolicyLimits } from "./resource-policy.js";

const taskIdSchema = z.string().min(1).max(256).regex(/^[^\u0000\r\n]+$/u);
const reserveEventSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("reserve"),
  reservationId: z.string().uuid(),
  taskId: taskIdSchema,
  reservedBytes: z.number().int().positive(),
  recordedAt: z.string().datetime(),
  taskExpiresAt: z.string().datetime().nullable(),
});
const settleEventSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("settle"),
  reservationId: z.string().uuid(),
  actualBytes: z.number().int().nonnegative(),
});
const budgetEventSchema = z.discriminatedUnion("type", [
  reserveEventSchema,
  settleEventSchema,
]);
type BudgetEvent = z.infer<typeof budgetEventSchema>;

const MAX_BUDGET_LOG_BYTES = 16 * 1_024 * 1_024;

export interface ResourceTaskBudgetUsage {
  requestsMade: number;
  /** Includes conservative outstanding reservations until they settle. */
  bytesRead: number;
}

export interface ResourceBudgetReservation {
  reservationId: string;
  taskId: string;
  reservedBytes: number;
}

export type ResourceBudgetReservationOutcome =
  | { outcome: "reserved"; reservation: ResourceBudgetReservation }
  | { outcome: "request_budget" }
  | { outcome: "byte_budget" };

export interface ResourceTaskBudgetLedger {
  usage(taskId: string, now?: Date): Promise<ResourceTaskBudgetUsage>;
  reserveRead(
    taskId: string,
    maximumBytes: number,
    limits: Readonly<ResourcePolicyLimits>,
    taskExpiresAt?: string | null,
    now?: Date,
  ): Promise<ResourceBudgetReservationOutcome>;
  settleRead(
    reservation: Readonly<ResourceBudgetReservation>,
    actualBytes: number,
  ): Promise<void>;
}

interface TaskUsage extends ResourceTaskBudgetUsage {
  taskExpiresAt: string | null;
}

interface ReservationState extends ResourceBudgetReservation {
  settled: boolean;
}

/** Process-local ledger used by tests and embedded connectors. */
export class InMemoryResourceTaskBudgetLedger
  implements ResourceTaskBudgetLedger
{
  protected readonly tasks = new Map<string, TaskUsage>();
  protected readonly reservations = new Map<string, ReservationState>();
  private queue: Promise<unknown> = Promise.resolve();

  async usage(taskId: string, now: Date = new Date()): Promise<ResourceTaskBudgetUsage> {
    return this.enqueue(async () => this.currentUsage(taskIdSchema.parse(taskId), now));
  }

  reserveRead(
    taskId: string,
    maximumBytes: number,
    limits: Readonly<ResourcePolicyLimits>,
    taskExpiresAt: string | null = null,
    now: Date = new Date(),
  ): Promise<ResourceBudgetReservationOutcome> {
    return this.enqueue(async () => {
      const safeTaskId = taskIdSchema.parse(taskId);
      validateLimits(limits);
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
        throw new Error("Resource budget reservation is invalid");
      }
      const usage = this.currentUsage(safeTaskId, now);
      if (usage.requestsMade >= limits.maxRequestsPerTask) {
        return { outcome: "request_budget" };
      }
      const remaining = limits.maxBytesPerTask - usage.bytesRead;
      if (remaining <= 0) return { outcome: "byte_budget" };
      const reservation: ResourceBudgetReservation = {
        reservationId: randomUUID(),
        taskId: safeTaskId,
        reservedBytes: Math.min(maximumBytes, remaining),
      };
      const expiry = normalizeExpiry(taskExpiresAt);
      await this.persist({
        version: 1,
        type: "reserve",
        ...reservation,
        recordedAt: now.toISOString(),
        taskExpiresAt: expiry,
      });
      this.applyReserve(reservation, expiry);
      return { outcome: "reserved", reservation };
    });
  }

  settleRead(
    reservation: Readonly<ResourceBudgetReservation>,
    actualBytes: number,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (
        !Number.isSafeInteger(actualBytes) ||
        actualBytes < 0 ||
        actualBytes > reservation.reservedBytes
      ) {
        throw new Error("Resource budget settlement is invalid");
      }
      const existing = this.reservations.get(reservation.reservationId);
      if (
        !existing ||
        existing.settled ||
        existing.taskId !== reservation.taskId ||
        existing.reservedBytes !== reservation.reservedBytes
      ) {
        throw new Error("Resource budget reservation is unavailable");
      }
      await this.persist({
        version: 1,
        type: "settle",
        reservationId: reservation.reservationId,
        actualBytes,
      });
      this.applySettle(existing, actualBytes);
    });
  }

  protected async persist(_event: BudgetEvent): Promise<void> {}

  protected applyEvent(event: BudgetEvent): void {
    if (event.type === "reserve") {
      this.applyReserve(event, event.taskExpiresAt);
      return;
    }
    const reservation = this.reservations.get(event.reservationId);
    if (!reservation || reservation.settled) {
      throw new Error("Resource budget ledger is unreadable");
    }
    this.applySettle(reservation, event.actualBytes);
  }

  private applyReserve(
    reservation: Readonly<ResourceBudgetReservation>,
    taskExpiresAt: string | null,
  ): void {
    if (this.reservations.has(reservation.reservationId)) {
      throw new Error("Resource budget ledger is unreadable");
    }
    const current = this.tasks.get(reservation.taskId) ?? {
      requestsMade: 0,
      bytesRead: 0,
      taskExpiresAt,
    };
    current.requestsMade += 1;
    current.bytesRead += reservation.reservedBytes;
    current.taskExpiresAt = laterExpiry(current.taskExpiresAt, taskExpiresAt);
    this.tasks.set(reservation.taskId, current);
    this.reservations.set(reservation.reservationId, {
      ...reservation,
      settled: false,
    });
  }

  private applySettle(reservation: ReservationState, actualBytes: number): void {
    const usage = this.tasks.get(reservation.taskId);
    if (!usage || actualBytes > reservation.reservedBytes) {
      throw new Error("Resource budget ledger is unreadable");
    }
    usage.bytesRead -= reservation.reservedBytes - actualBytes;
    if (usage.bytesRead < 0) throw new Error("Resource budget ledger is unreadable");
    reservation.settled = true;
  }

  private currentUsage(taskId: string, now: Date): ResourceTaskBudgetUsage {
    const usage = this.tasks.get(taskId);
    if (
      !usage ||
      (usage.taskExpiresAt !== null &&
        Date.parse(usage.taskExpiresAt) <= now.getTime())
    ) {
      return { requestsMade: 0, bytesRead: 0 };
    }
    return { requestsMade: usage.requestsMade, bytesRead: usage.bytesRead };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

/**
 * Append-only connector-local ledger.
 *
 * A reservation is fsynced before the file read. If the connector crashes,
 * its maximum byte allowance remains charged, which can deny a retry but can
 * never reset or exceed the task-wide budget. A settlement later refunds only
 * the unused part of that reservation.
 */
export class FileResourceTaskBudgetLedger extends InMemoryResourceTaskBudgetLedger {
  private loaded: Promise<void> | undefined;

  constructor(private readonly filePath: string) {
    super();
    if (!path.isAbsolute(filePath)) {
      throw new Error("Resource budget ledger path must be absolute");
    }
  }

  override async usage(
    taskId: string,
    now: Date = new Date(),
  ): Promise<ResourceTaskBudgetUsage> {
    await this.ensureLoaded();
    return super.usage(taskId, now);
  }

  override async reserveRead(
    taskId: string,
    maximumBytes: number,
    limits: Readonly<ResourcePolicyLimits>,
    taskExpiresAt: string | null = null,
    now: Date = new Date(),
  ): Promise<ResourceBudgetReservationOutcome> {
    await this.ensureLoaded();
    return super.reserveRead(taskId, maximumBytes, limits, taskExpiresAt, now);
  }

  override async settleRead(
    reservation: Readonly<ResourceBudgetReservation>,
    actualBytes: number,
  ): Promise<void> {
    await this.ensureLoaded();
    return super.settleRead(reservation, actualBytes);
  }

  protected override async persist(event: BudgetEvent): Promise<void> {
    const line = JSON.stringify(event) + "\n";
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const handle = await open(this.filePath, "a", 0o600);
    try {
      const stats = await handle.stat();
      if (stats.size + Buffer.byteLength(line) > MAX_BUDGET_LOG_BYTES) {
        throw new Error("Resource budget ledger capacity exceeded");
      }
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
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
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw new Error("Resource budget ledger is unreadable");
    }
    if (Buffer.byteLength(raw) > MAX_BUDGET_LOG_BYTES) {
      throw new Error("Resource budget ledger is unreadable");
    }
    const lines = raw.split("\n");
    const hasTrailingNewline = lines.at(-1) === "";
    if (hasTrailingNewline) lines.pop();
    for (const [index, line] of lines.entries()) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        // A process can die between writing the last bytes and fsync. That
        // incomplete reservation was never allowed to precede a file read, so
        // only malformed JSON in the final unterminated line may be removed.
        if (!hasTrailingNewline && index === lines.length - 1) {
          await this.removeIncompleteTail(raw);
          return;
        }
        throw new Error("Resource budget ledger is unreadable");
      }
      try {
        this.applyEvent(budgetEventSchema.parse(decoded));
      } catch {
        // A syntactically complete but invalid event is corruption or
        // tampering. Never erase it and accidentally refill a task.
        throw new Error("Resource budget ledger is unreadable");
      }
    }
  }

  private async removeIncompleteTail(raw: string): Promise<void> {
    const lastNewline = raw.lastIndexOf("\n");
    const validPrefix = lastNewline < 0 ? "" : raw.slice(0, lastNewline + 1);
    const handle = await open(this.filePath, "r+");
    try {
      await handle.truncate(Buffer.byteLength(validPrefix, "utf8"));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function validateLimits(limits: Readonly<ResourcePolicyLimits>): void {
  for (const value of [
    limits.maxRequestsPerTask,
    limits.maxBytesPerTask,
    limits.maxBytesPerResource,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("Resource policy limits are invalid");
    }
  }
}

function normalizeExpiry(value: string | null): string | null {
  if (value === null) return null;
  return z.string().datetime().parse(value);
}

function laterExpiry(left: string | null, right: string | null): string | null {
  // Null is an unknown lifetime. It must remain unbounded locally rather than
  // letting a later known grant erase budget history for the same task.
  if (left === null || right === null) return null;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
