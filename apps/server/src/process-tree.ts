import { spawn, type ChildProcess } from "node:child_process";

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
      // Detached and unref'd: this is a cleanup helper, and the caller already
      // waits on the child's own close event rather than on taskkill.
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      });
      killer.on("error", () => undefined);
      killer.unref();
      return true;
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

/**
 * Escalating termination: ask the tree to stop, then force it.
 *
 * Returns the force timer so a caller that settles first can clear it. The
 * timer is unref'd so a pending force kill never holds the process open.
 */
export function terminateProcessTreeGracefully(
  child: ChildProcess,
  forceAfterMs: number,
): NodeJS.Timeout {
  if (!terminateProcessTree(child, "SIGTERM")) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (!terminateProcessTree(child, "SIGKILL")) child.kill("SIGKILL");
  }, forceAfterMs);
  timer.unref();
  return timer;
}
