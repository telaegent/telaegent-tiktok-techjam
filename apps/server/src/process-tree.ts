import { spawnSync, type ChildProcess } from "node:child_process";

/** Safe sentinel for a tree whose disappearance could not be established. */
export class UnverifiedProcessTreeTerminationError extends Error {
  constructor() {
    super("Provider process-tree termination could not be verified");
    this.name = "UnverifiedProcessTreeTerminationError";
  }
}

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
      // Only a successful tree walk proves cleanup. In particular, status 128
      // means the root disappeared before taskkill could walk it; descendants
      // may still be alive and must not be reported as stopped.
      return !result.error && result.status === 0;
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
  postKillWaitMs = 1_000,
): Promise<boolean> {
  const pid = child.pid;
  const treeSignalled = terminateProcessTree(child, "SIGTERM");
  if (!treeSignalled) child.kill("SIGTERM");

  // taskkill /T /F is synchronous and already forceful on Windows. Its return
  // value is the only proof available without a Job Object established at
  // spawn time, so propagate failure instead of claiming cleanup.
  if (process.platform === "win32" || pid === undefined) return treeSignalled;

  const deadline = Date.now() + gracePeriodMs;
  while (processGroupIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))),
    );
  }
  if (!processGroupIsAlive(pid)) return true;

  if (!terminateProcessTree(child, "SIGKILL")) child.kill("SIGKILL");

  const postKillDeadline = Date.now() + postKillWaitMs;
  while (processGroupIsAlive(pid) && Date.now() < postKillDeadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, Math.max(1, postKillDeadline - Date.now()))),
    );
  }
  return !processGroupIsAlive(pid);
}

/**
 * Waits for either the provider parent or a requested tree termination.
 *
 * `ChildProcess` emits `exit` before `close`; a surviving descendant can keep
 * inherited pipes open forever and prevent `close`. Once termination starts,
 * its bounded verification must therefore be able to settle the runner on its
 * own. A verified termination uses a non-zero synthetic exit code so the
 * caller's already-recorded cancel/timeout/output-limit flag remains the
 * authoritative result. An unverified termination rejects with a safe sentinel
 * rather than waiting forever for the blocked close event.
 */
export async function waitForProcessExitOrTreeTermination(
  processExit: Promise<number>,
  terminationResult: Promise<boolean>,
): Promise<number> {
  const outcome = await Promise.race([
    processExit.then((exitCode) => ({ kind: "process" as const, exitCode })),
    terminationResult.then((verified) => ({
      kind: "termination" as const,
      verified,
    })),
  ]);

  if (outcome.kind === "process") return outcome.exitCode;
  if (!outcome.verified) throw new UnverifiedProcessTreeTerminationError();
  return 1;
}
