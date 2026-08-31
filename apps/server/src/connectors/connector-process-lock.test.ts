import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireConnectorProcessLock,
  ConnectorAlreadyRunningError,
} from "./connector-process-lock.js";

const binding = "50000000-0000-4000-8000-000000000005";
const otherBinding = "50000000-0000-4000-8000-000000000006";
const roots: string[] = [];

async function stateDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "telaegent-process-lock-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("connector process singleton", () => {
  it("elects exactly one winner when two processes race to claim the binding", async () => {
    const root = await stateDirectory();
    const attempts = await Promise.allSettled([
      acquireConnectorProcessLock(binding, {
        stateDirectory: root,
        pid: 101,
        token: "a".repeat(64),
        settleMs: 0,
        processIsAlive: (pid) => pid === 101 || pid === 202,
      }),
      acquireConnectorProcessLock(binding, {
        stateDirectory: root,
        pid: 202,
        token: "b".repeat(64),
        settleMs: 0,
        processIsAlive: (pid) => pid === 101 || pid === 202,
      }),
    ]);

    const winners = attempts.filter(
      (result): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof acquireConnectorProcessLock>>
      > =>
        result.status === "fulfilled",
    );
    const losers = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toBeInstanceOf(ConnectorAlreadyRunningError);
    await winners[0]!.value.release();
  });

  it("rejects a second live process for the same repository binding", async () => {
    const root = await stateDirectory();
    const first = await acquireConnectorProcessLock(binding, {
      stateDirectory: root,
      pid: 101,
      token: "a".repeat(64),
      settleMs: 0,
      processIsAlive: (pid) => pid === 101,
    });

    await expect(
      acquireConnectorProcessLock(binding, {
        stateDirectory: root,
        pid: 202,
        token: "b".repeat(64),
        settleMs: 0,
        processIsAlive: (pid) => pid === 101,
      }),
    ).rejects.toBeInstanceOf(ConnectorAlreadyRunningError);
    await first.release();
  });

  it("allows separate repository bindings to run independently", async () => {
    const root = await stateDirectory();
    const first = await acquireConnectorProcessLock(binding, {
      stateDirectory: root,
      pid: 101,
      token: "a".repeat(64),
      settleMs: 0,
    });
    const second = await acquireConnectorProcessLock(otherBinding, {
      stateDirectory: root,
      pid: 101,
      token: "b".repeat(64),
      settleMs: 0,
    });

    await second.release();
    await first.release();
  });

  it("reclaims a dead owner's lock without letting the old owner release the successor", async () => {
    const root = await stateDirectory();
    const old = await acquireConnectorProcessLock(binding, {
      stateDirectory: root,
      pid: 101,
      token: "a".repeat(64),
      settleMs: 0,
    });
    const successor = await acquireConnectorProcessLock(binding, {
      stateDirectory: root,
      pid: 202,
      token: "b".repeat(64),
      settleMs: 0,
      processIsAlive: () => false,
    });

    await old.release();
    await expect(
      acquireConnectorProcessLock(binding, {
        stateDirectory: root,
        pid: 303,
        token: "c".repeat(64),
        settleMs: 0,
        processIsAlive: (pid) => pid === 202,
      }),
    ).rejects.toBeInstanceOf(ConnectorAlreadyRunningError);
    await successor.release();
  });

  it("can be reacquired after an orderly release", async () => {
    const root = await stateDirectory();
    const first = await acquireConnectorProcessLock(binding, {
      stateDirectory: root,
      pid: 101,
      token: "a".repeat(64),
      settleMs: 0,
    });
    await first.release();

    const second = await acquireConnectorProcessLock(binding, {
      stateDirectory: root,
      pid: 202,
      token: "b".repeat(64),
      settleMs: 0,
    });
    await second.release();
  });
});
