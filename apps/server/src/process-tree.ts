import { spawnSync, type ChildProcess } from "node:child_process";

/**
 * Terminating a provider CLI has to stop everything it started.
 *
 * A coding agent is a process tree, not a process: the CLI spawns shells, test
 * runners, language servers and git. Signalling only the parent can leave those
 * descendants running against the owner's repository after the owner pressed
 * Cancel, and an inherited stdout pipe held open by a survivor keeps the run
 * from settling. Cancellation and timeout both promise to stop all owned
 * execution, so both go through here.
 *
 * The two platforms need different mechanisms:
 *
 *   POSIX  - the child is spawned detached, which makes it the leader of a new
 *            process group. Signalling the negated PID reaches the whole group.
 *   Windows - there is no process group to signal, so `taskkill /T` walks the
 *            child tree. It is always forceful; Windows has no SIGTERM.
 */

/** Spawn options that let {@link terminateProcessTree} reach descendants. */
export const processTreeSpawnOptions: Readonly<{ detached: boolean }> =
  // On Windows `detached` would allocate a new console for the child rather
  // than group it, which is both unwanted and unnecessary: taskkill walks the
  // tree from the parent PID regardless.
  Object.freeze({ detached: process.platform !== "win32" });

/**
 * Signals a child and every process it started.
 *
 * Never throws: termination runs on cancellation, timeout and cleanup paths
 * where a failure to signal an already-dead process must not mask the real
 * outcome. Returns false when the tree could not be signalled, so a caller can
 * still fall back to signalling the parent alone.
 */
export function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;

  if (process.platform === "win32") {
    try {
      // Wait for taskkill to finish. An asynchronous fire-and-forget spawn can
      // report success here and fail on its later `error`/`close` event, which
      // suppresses the caller's parent-process fallback and can leave a
      // descendant alive after Cancel returns.
      const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
        // Cleanup must not freeze the connector if Windows process inspection
        // itself is unhealthy. A timeout is a failure and activates the
        // caller's direct-parent fallback.
        timeout: 5_000,
      });
      // taskkill uses 128 when the target disappeared before it was signalled;
      // that is already the desired terminal state. Every other failure lets
      // the runner fall back to signalling the parent directly.
      return !result.error && (result.status === 0 || result.status === 128);
    } catch {
      return false;
    }
  }

  try {
    // Negated PID addresses the process group the detached spawn created.
    process.kill(-pid, signal);
    return true;
  } catch {
    // ESRCH means the group is already gone, which is the desired end state.
    // Anything else (a child that was not detached, EPERM) falls back to the
    // parent so termination still happens, just without the descendants.
    return false;
  }
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // A permissions failure still proves the group exists. Only ESRCH means
    // there is no remaining process for an escalation to reach.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Starts graceful tree termination and waits until the tree is gone, forcing
 * any surviving descendants after the grace period.
 *
 * Waiting for the parent process is insufficient: it can accept SIGTERM while
 * a shell or test runner it spawned ignores it. Keeping the escalation owned
 * here prevents runner cleanup from cancelling the force kill when that parent
 * closes first.
 */
export async function terminateProcessTreeWithEscalation(
  child: ChildProcess,
  gracePeriodMs = 3_000,
): Promise<void> {
  const pid = child.pid;
  const treeSignalled = terminateProcessTree(child, "SIGTERM");
  if (!treeSignalled) child.kill("SIGTERM");

  // taskkill /T /F is synchronous and already forceful on Windows.
  if (process.platform === "win32" || pid === undefined) return;

  const deadline = Date.now() + gracePeriodMs;
  while (processGroupIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))),
    );
  }
  if (!processGroupIsAlive(pid)) return;

  if (!terminateProcessTree(child, "SIGKILL")) child.kill("SIGKILL");
}
