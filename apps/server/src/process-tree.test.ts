/**
 * Terminating a provider CLI has to stop the tree it started.
 *
 * A coding agent spawns shells, test runners and git. Signalling only the
 * parent leaves those descendants running against the owner's repository after
 * the owner pressed Cancel, and a survivor holding an inherited stdout pipe
 * keeps the run from ever settling.
 *
 * These tests use a real process tree because that is the only thing that
 * distinguishes the bug from the fix: a parent that spawns a long-lived child
 * and exits immediately. Mocking `kill` would assert on the call shape while
 * proving nothing about whether the grandchild died.
 */

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  processTreeSpawnOptions,
  terminateProcessTree,
} from "./process-tree.js";

/**
 * A parent that outlives nothing and a child that outlives everything.
 *
 * The parent spawns a detached sleeper, prints its PID, and returns. Killing
 * only the parent therefore leaves the sleeper behind, which is exactly the
 * failure being tested.
 */
const parentScript = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: "ignore",
  // Detached so the descendant genuinely outlives its parent. Without this,
  // Windows tears the whole job down with the parent and the test could not
  // tell a tree kill apart from a parent kill.
  detached: true,
});
child.unref();
process.stdout.write(String(child.pid));
setTimeout(() => {}, 60000);
`;

function alive(pid: number): boolean {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

describe("terminateProcessTree", () => {
  it("stops a descendant the parent spawned", async () => {
    const parent = spawn(process.execPath, ["-e", parentScript], {
      stdio: ["ignore", "pipe", "ignore"],
      ...processTreeSpawnOptions,
    });
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      let buffered = "";
      parent.stdout?.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const parsed = Number.parseInt(buffered, 10);
        if (Number.isInteger(parsed) && parsed > 0) resolve(parsed);
      });
      parent.once("error", reject);
      setTimeout(() => reject(new Error("child never reported a PID")), 10_000);
    });

    expect(alive(grandchildPid)).toBe(true);
    terminateProcessTree(parent, "SIGKILL");

    // The descendant, not merely the process that was signalled.
    await expect(waitUntilGone(grandchildPid)).resolves.toBe(true);
    await expect(waitUntilGone(parent.pid!)).resolves.toBe(true);
  }, 30_000);

  it("reports failure rather than throwing for a process that is already gone", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("close", () => resolve()));

    // Cancellation, timeout and cleanup all call this; none may be masked by a
    // throw from signalling something that already exited.
    expect(() => terminateProcessTree(child, "SIGKILL")).not.toThrow();
  }, 30_000);
});
