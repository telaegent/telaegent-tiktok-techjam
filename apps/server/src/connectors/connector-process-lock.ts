import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  connectorStateDirectory,
  type ConnectorStateLocationOptions,
} from "./connector-local-state.js";

const claimPattern = /^(?<pid>[1-9][0-9]*)-(?<token>[0-9a-f]{64})\.claim$/;

/** Body of a claim file. Only `acquiredAt` is read back, as an ordering key. */
const claimBodySchema = z.object({ acquiredAt: z.string() });

/**
 * How often an owner restamps its claim, and how long a claim outlives its last
 * stamp. The gap absorbs a scheduler or collector pause without letting a
 * contender steal a running connector's binding, and the ceiling bounds how long
 * a hard-killed connector blocks its own restart.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 30_000;

export class ConnectorAlreadyRunningError extends Error {
  constructor(staleAfterMs: number = DEFAULT_STALE_AFTER_MS) {
    super(
      "A Telaegent connector is already running for this repository binding. " +
        "A connector that was killed releases its claim within " +
        Math.ceil(staleAfterMs / 1_000) +
        " seconds.",
    );
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
  /** How often this process restamps its own claim while it holds the lock. */
  heartbeatIntervalMs?: number;
  /** How long another process's claim survives its last stamp. */
  staleAfterMs?: number;
}

interface ProcessClaim {
  path: string;
  pid: number;
  token: string;
  createdAtNs: bigint;
  heartbeatAtMs: number;
}

/**
 * Claims one connector process for one durable user x repository binding.
 *
 * Every contender first installs its own exclusive claim, then all contenders
 * elect the oldest live claim (with a token tie-breaker). A process that starts
 * later can therefore never preempt one that already entered the runtime.
 * There is no shared lock file to overwrite or stale pointer to race over.
 *
 * Liveness is a heartbeat, not a PID. `process.kill(pid, 0)` answers "is this
 * PID resolvable", which is a different question: Windows keeps an exited
 * process addressable for as long as anyone still holds an open handle to it,
 * and the shell that launched the connector holds one. A hard-killed connector
 * therefore looked alive indefinitely, and its claim blocked every reconnect
 * until someone deleted the file by hand. An owner that is genuinely running
 * keeps restamping its claim; an owner that is not stops, whatever its PID
 * still answers. The PID test is kept as the cheap half, because where it does
 * report death the successor takes over at once instead of waiting out the
 * staleness window.
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
  const now = options.now ?? (() => new Date());
  const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
  const settleMs = options.settleMs ?? 50;
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 1_000) {
    throw new Error("Connector process lock settle interval is invalid");
  }
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) {
    throw new Error("Connector process lock heartbeat interval is invalid");
  }
  // A window no wider than this process's own beat would let it call a peer
  // dead in the ordinary gap between that peer's stamps.
  if (!Number.isInteger(staleAfterMs) || staleAfterMs <= heartbeatIntervalMs) {
    throw new Error("Connector process lock staleness window is invalid");
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
    acquiredAt: now().toISOString(),
  });
  // Restamping is the one liveness signal that cannot outlive the process: the
  // writes stop the instant it does, however it died. Unref'd, so holding the
  // lock never keeps an otherwise finished connector running.
  const heartbeat = setInterval(() => {
    const at = now();
    void utimes(ownPath, at, at).catch(() => undefined);
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  try {
    await (options.sleep ?? sleep)(settleMs);
    const nowMs = now().getTime();
    const live: ProcessClaim[] = [];
    for (const claim of await listClaims(directory)) {
      if (
        claim.token === token ||
        (processIsAlive(claim.pid) && nowMs - claim.heartbeatAtMs <= staleAfterMs)
      ) {
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
    if (live[0]?.token !== token) throw new ConnectorAlreadyRunningError(staleAfterMs);
    return {
      release: async () => {
        clearInterval(heartbeat);
        await unlink(ownPath).catch(ignoreMissing);
      },
    };
  } catch (error) {
    clearInterval(heartbeat);
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
      // Election order must not move when a heartbeat restamps a file, so mtime
      // is the last resort rather than the second choice. Where the filesystem
      // records no birth time, the instant the claim recorded for itself at
      // acquisition stands in.
      createdAtNs:
        claimStat.birthtimeNs > 0n
          ? claimStat.birthtimeNs
          : ((await recordedAcquisitionNs(claimPath)) ?? claimStat.mtimeNs),
      heartbeatAtMs: Number(claimStat.mtimeNs / 1_000_000n),
    });
  }
  return claims;
}

async function recordedAcquisitionNs(claimPath: string): Promise<bigint | null> {
  try {
    const body = claimBodySchema.safeParse(
      JSON.parse(await readFile(claimPath, "utf8")),
    );
    if (!body.success) return null;
    const acquiredAtMs = Date.parse(body.data.acquiredAt);
    return Number.isFinite(acquiredAtMs) ? BigInt(acquiredAtMs) * 1_000_000n : null;
  } catch {
    // A claim caught between create and write has recorded no instant yet.
    return null;
  }
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
