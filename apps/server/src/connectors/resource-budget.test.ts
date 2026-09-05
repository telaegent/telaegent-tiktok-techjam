import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileResourceTaskBudgetLedger,
  InMemoryResourceTaskBudgetLedger,
} from "./resource-budget.js";

const taskId = "20000000-0000-4000-8000-000000000001";
const now = new Date("2026-09-05T01:00:00.000Z");
const expiry = "2026-09-05T02:00:00.000Z";
const limits = {
  maxRequestsPerTask: 2,
  maxBytesPerTask: 10,
  maxBytesPerResource: 8,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("resource task budget ledger", () => {
  it("reserves before a read and refunds only unused bytes after settlement", async () => {
    const ledger = new InMemoryResourceTaskBudgetLedger();
    const result = await ledger.reserveRead(taskId, 8, limits, expiry, now);
    expect(result.outcome).toBe("reserved");
    if (result.outcome !== "reserved") throw new Error("expected reservation");

    expect(await ledger.usage(taskId, now)).toEqual({
      requestsMade: 1,
      bytesRead: 8,
    });
    await ledger.settleRead(result.reservation, 3);
    expect(await ledger.usage(taskId, now)).toEqual({
      requestsMade: 1,
      bytesRead: 3,
    });
  });

  it("persists usage across connector restarts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "telaegent-budget-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "budget.jsonl");
    const first = new FileResourceTaskBudgetLedger(file);
    const reserved = await first.reserveRead(taskId, 8, limits, expiry, now);
    if (reserved.outcome !== "reserved") throw new Error("expected reservation");
    await first.settleRead(reserved.reservation, 6);

    const restarted = new FileResourceTaskBudgetLedger(file);
    expect(await restarted.usage(taskId, now)).toEqual({
      requestsMade: 1,
      bytesRead: 6,
    });
    const second = await restarted.reserveRead(taskId, 8, limits, expiry, now);
    expect(second).toMatchObject({
      outcome: "reserved",
      reservation: { reservedBytes: 4 },
    });
    expect(await restarted.reserveRead(taskId, 1, limits, expiry, now)).toEqual({
      outcome: "request_budget",
    });
  });

  it("keeps an unsettled crash reservation charged conservatively", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "telaegent-budget-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "budget.jsonl");
    const first = new FileResourceTaskBudgetLedger(file);
    await first.reserveRead(taskId, 8, limits, expiry, now);

    const restarted = new FileResourceTaskBudgetLedger(file);
    expect(await restarted.usage(taskId, now)).toEqual({
      requestsMade: 1,
      bytesRead: 8,
    });
  });
});
