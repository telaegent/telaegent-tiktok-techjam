import assert from "node:assert/strict";
import test from "node:test";
import { terminateProcessTree, windowsTaskkillArgs } from "./process-tree.mjs";

test("builds a Windows process-tree termination command without a shell", () => {
  assert.deepEqual(windowsTaskkillArgs(4321), ["/PID", "4321", "/T", "/F"]);
  assert.throws(() => windowsTaskkillArgs(0), /valid child PID/u);
});

test("terminates the complete Windows child tree", () => {
  const calls = [];
  const child = { pid: 4321, exitCode: null, signalCode: null, kill: () => assert.fail() };
  assert.equal(terminateProcessTree(child, {
    platform: "win32",
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  }), true);
  assert.deepEqual(calls[0], {
    command: "taskkill",
    args: ["/PID", "4321", "/T", "/F"],
    options: { stdio: "ignore", windowsHide: true, shell: false },
  });
});

test("terminates the POSIX process group", () => {
  const calls = [];
  const child = { pid: 987, exitCode: null, signalCode: null, kill: () => assert.fail() };
  assert.equal(terminateProcessTree(child, {
    platform: "linux",
    kill(pid, signal) { calls.push({ pid, signal }); },
  }), true);
  assert.deepEqual(calls, [{ pid: -987, signal: "SIGTERM" }]);
});
