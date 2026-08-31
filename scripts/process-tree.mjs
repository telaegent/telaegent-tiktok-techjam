import { spawnSync } from "node:child_process";

export function windowsTaskkillArgs(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("A valid child PID is required");
  return ["/PID", String(pid), "/T", "/F"];
}

export function terminateProcessTree(child, options = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return false;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const run = options.spawnSync ?? spawnSync;
    const result = run("taskkill", windowsTaskkillArgs(child.pid), {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    if (result.error || (result.status !== 0 && result.status !== 128)) {
      child.kill();
    }
    return true;
  }

  const kill = options.kill ?? process.kill;
  try {
    // POSIX children are detached into their own process group by the dev runner.
    kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  return true;
}
