import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  connectorStateDirectory,
  type ConnectorStateLocationOptions,
} from "./connector-local-state.js";

const claimPattern = /^(?<pid>[1-9][0-9]*)-(?<token>[0-9a-f]{64})\.claim$/;

export class ConnectorAlreadyRunningError extends Error {
  constructor() {
    super("A Telaegent connector is already running for this repository binding");
    this.name = "ConnectorAlreadyRunningError";
  }
}

export interface ConnectorProcessLock {
  release(): Promise<void>;
}

export interface ConnectorProcessLockOptions extends ConnectorStateLocationOptions {
  stateDirectory?: string;
  pid?: number;
  now?: () => Date;
  processIsAlive?: (pid: number) => boolean;
  token?: string;
  settleMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

interface ProcessClaim {
  path: string;
  pid: number;
  token: string;
  createdAtNs: bigint;
}

/**
 * Claims one connector process for one durable user x repository binding.
 *
 * Every contender first installs its own exclusive claim, then all contenders
 * elect the oldest live claim (with a token tie-breaker). A process that starts
 * later can therefore never preempt one that already entered the runtime.
 * There is no shared lock file to overwrite or stale pointer to race over. A
 * crashed process's exact claim is removed only after its PID is no longer
 * alive.
 *
 * Registry records remain cross-process safe as defense in depth. This lock
 * protects the wider runtime: two processes must not compete for one long-poll
 * lease or concurrently use the same provider-session namespace.
 */
export async function acquireConnectorProcessLock(
  connectorBindingId: string,
  options: ConnectorProcessLockOptions = {},
): Promise<ConnectorProcessLock> {
  const bindingId = z.string().uuid().parse(connectorBindingId);
  const stateDirectory = options.stateDirectory ?? connectorStateDirectory(options);
  if (!path.isAbsolute(stateDirectory)) {
    throw new Error("Connector state directory must be absolute");
  }
  const directory = path.join(stateDirectory, "process-locks", bindingId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pid = z.number().int().positive().max(2_147_483_647).parse(
    options.pid ?? process.pid,
  );
  const token = z.string().regex(/^[0-9a-f]{64}$/).parse(
    options.token ?? randomBytes(32).toString("hex"),
  );
  const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
  const settleMs = options.settleMs ?? 50;
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 1_000) {
    throw new Error("Connector process lock settle interval is invalid");
  }

  // A PID cannot belong to two live local processes. Remove an abandoned
  // claim left by an older process whose PID the OS has since reused before
  // installing the new token for that PID.
  for (const claim of await listClaims(directory)) {
    if (claim.pid === pid) await unlink(claim.path).catch(ignoreMissing);
  }

  const ownPath = path.join(directory, `${pid}-${token}.claim`);
  await installClaim(ownPath, {
    version: 1,
    pid,
    token,
    acquiredAt: (options.now ?? (() => new Date()))().toISOString(),
  });

  try {
    await (options.sleep ?? sleep)(settleMs);
    const live: ProcessClaim[] = [];
    for (const claim of await listClaims(directory)) {
      if (claim.token === token || processIsAlive(claim.pid)) {
        live.push(claim);
      } else {
        await unlink(claim.path).catch(ignoreMissing);
      }
    }
    live.sort((left, right) =>
      left.createdAtNs < right.createdAtNs
        ? -1
        : left.createdAtNs > right.createdAtNs
          ? 1
          : left.token.localeCompare(right.token),
    );
    if (live[0]?.token !== token) throw new ConnectorAlreadyRunningError();
    return { release: () => unlink(ownPath).catch(ignoreMissing) };
  } catch (error) {
    await unlink(ownPath).catch(ignoreMissing);
    throw error;
  }
}

async function installClaim(pathname: string, payload: unknown): Promise<void> {
  const handle = await open(pathname, "wx", 0o600);
  let failure: unknown;
  try {
    await handle.writeFile(JSON.stringify(payload), "utf8");
    await handle.sync();
  } catch (error) {
    failure = error;
  } finally {
    await handle.close();
  }
  if (failure !== undefined) {
    await unlink(pathname).catch(ignoreMissing);
    throw failure;
  }
}

async function listClaims(directory: string): Promise<ProcessClaim[]> {
  const claims: ProcessClaim[] = [];
  for (const filename of await readdir(directory)) {
    const match = claimPattern.exec(filename);
    if (!match?.groups) continue;
    const pid = Number(match.groups.pid);
    if (!Number.isSafeInteger(pid)) continue;
    const claimPath = path.join(directory, filename);
    let claimStat;
    try {
      claimStat = await stat(claimPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    claims.push({
      path: claimPath,
      pid,
      token: match.groups.token!,
      createdAtNs:
        claimStat.birthtimeNs > 0n ? claimStat.birthtimeNs : claimStat.mtimeNs,
    });
  }
  return claims;
}

async function sleep(delayMs: number): Promise<void> {
  if (delayMs === 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
}
