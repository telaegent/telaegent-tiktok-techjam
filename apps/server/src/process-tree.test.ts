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
/**
 * The descendant's `detached` flag differs by platform, and it has to.
 *
 * On Linux a plain child already outlives its parent -- nothing reaps it, it
 * is simply reparented -- so leaving it attached is both the realistic case
 * (a shell the CLI spawned) and the one that proves the fix: it stays in the
 * process group, so only a group kill reaches it. Detaching it there would
 * make it a group leader of its own and it would survive the very mechanism
 * under test.
 *
 * On Windows the opposite is needed. A plain child is torn down with the
 * parent's job object, so the test could not tell a tree kill from a parent
 * kill unless the descendant genuinely escapes first.
 */
const parentScript = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: "ignore",
  detached: process.platform === "win32",
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
