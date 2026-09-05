import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  RealpathWorkspaceBoundary,
  type WorkspaceBoundary,
} from "../authorization/workspace-boundary.js";
import { containsSecretLikeContent } from "../telagent/redaction.js";
import { isDeniedPath, type ResourceDenyCode } from "./resource-policy.js";

const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);

/**
 * Audit metadata for one delivered snapshot (build plan 8.6).
 *
 * Records that a read happened and what it was, never what it said. Raw file
 * contents are deliberately absent: the hash lets an auditor prove which bytes
 * were delivered without the audit trail itself becoming a copy of the file.
 */
export interface DeliveredSnapshotAudit {
  resourceId: string;
  taskId: string;
  recipientUserId: string;
  byteLength: number;
  contentSha256: string;
  authorizationMode: "once" | "task";
  truncated: boolean;
  deliveredAt: string;
}

export interface BrokeredRead {
  content: string;
  audit: DeliveredSnapshotAudit;
}

export type BrokerFailure = { code: ResourceDenyCode | "UNREADABLE" };

export interface LocatedResource {
  canonicalPath: string;
}

export interface FileBrokerReadInput {
  taskId: string;
  resourceId: string;
  recipientUserId: string;
  canonicalPath: string;
  authorizationMode: "once" | "task";
  maxBytes: number;
}

/**
 * Performs the one authorized read, and re-proves authorization while doing it.
 *
 * Every check the policy engine already made is made again here against the
 * live filesystem. That is intentional duplication: the policy decided against
 * a snapshot of state, and between that decision and this read a path can be
 * replaced by a symlink, a file can be swapped for a device, or a workspace can
 * be moved. Build plan 8.4 requires the re-check immediately before the read.
 */
export class LocalFileBroker {
  private readonly boundary: WorkspaceBoundary;

  constructor(
    private readonly workspacePath: string,
    boundary?: WorkspaceBoundary,
  ) {
    this.boundary = boundary ?? new RealpathWorkspaceBoundary(workspacePath);
  }

  /**
   * Turns a project-relative description into the file a human can be asked
   * about.
   *
   * Locating is not authorizing. This runs before anyone has approved
   * anything, purely so the owning human is offered a real file rather than a
   * peer's raw text, and it reads nothing. The text came from a peer's agent,
   * which may only ever describe a file: an absolute path or a traversal is
   * refused outright rather than normalized into something reachable.
   *
   * Every failure is the caller's cue to stay silent, not to explain, so a peer
   * cannot tell a missing file from a secret one.
   */
  async locate(projectRelativePath: string): Promise<LocatedResource | BrokerFailure> {
    if (projectRelativePath.includes(NUL)) return { code: "OUTSIDE_WORKSPACE" };
    if (
      path.posix.isAbsolute(projectRelativePath) ||
      path.win32.isAbsolute(projectRelativePath)
    ) {
      return { code: "OUTSIDE_WORKSPACE" };
    }
    // Split on both separators: the hint crosses machines, so a peer on one
    // platform must not be able to hide a traversal in the other's separator.
    const segments = projectRelativePath
      .split(path.sep)
      .flatMap((part) => part.split("/"))
      .flatMap((part) => part.split(BACKSLASH));
    if (segments.some((segment) => segment === "..")) {
      return { code: "OUTSIDE_WORKSPACE" };
    }

    const canonicalPath = path.resolve(this.workspacePath, projectRelativePath);
    if (isDeniedPath(canonicalPath, this.workspacePath)) return { code: "SECRET_PATH" };
    if (!(await this.boundary.contains({ workspacePath: canonicalPath }))) {
      return { code: "OUTSIDE_WORKSPACE" };
    }

    let handle;
    try {
      handle = await open(canonicalPath, "r");
    } catch {
      return { code: "UNREADABLE" };
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) return { code: "UNREADABLE" };
      return { canonicalPath };
    } catch {
      return { code: "UNREADABLE" };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async read(
    input: Readonly<FileBrokerReadInput>,
    now: () => Date = () => new Date(),
  ): Promise<BrokeredRead | BrokerFailure> {
    // Re-screened before containment so a secret outside the workspace is
    // refused as a secret, never as a location the peer could distinguish.
    if (isDeniedPath(input.canonicalPath, this.workspacePath)) {
      return { code: "SECRET_PATH" };
    }
    if (!(await this.boundary.contains({ workspacePath: input.canonicalPath }))) {
      return { code: "OUTSIDE_WORKSPACE" };
    }

    let handle;
    try {
      // Opened before stat so the descriptor and the metadata describe the same
      // file. Checking a path then opening it is a race a symlink swap wins.
      handle = await open(input.canonicalPath, "r");
    } catch {
      return { code: "UNREADABLE" };
    }
    try {
      const stats = await handle.stat();
      // A directory, socket, fifo or device is not a readable resource, and
      // reading one can block the connector indefinitely.
      if (!stats.isFile()) return { code: "UNREADABLE" };

      const openedFileFailure = await this.verifyOpenedFile(
        input.canonicalPath,
        stats,
      );
      if (openedFileFailure) return openedFileFailure;

      const limit = Math.max(0, Math.floor(input.maxBytes));
      const truncated = stats.size > limit;
      const length = truncated ? limit : stats.size;
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      const delivered = buffer.subarray(0, filled);
      // The descriptor is stable, but the path may have been swapped while the
      // bytes were read. Do not release the snapshot unless the live path still
      // resolves inside this workspace and still identifies this descriptor.
      const finalFailure = await this.verifyOpenedFile(
        input.canonicalPath,
        stats,
      );
      if (finalFailure) return finalFailure;
      const content = delivered.toString("utf8");
      // A grant authorizes a resource, not every byte it may contain forever.
      // Re-scan each snapshot so a harmless file that later gains a credential
      // cannot ride an existing task grant across the trust boundary.
      if (containsSecretLikeContent(content)) {
        return { code: "SECRET_CONTENT" };
      }
      return {
        content,
        audit: {
          taskId: input.taskId,
          resourceId: input.resourceId,
          recipientUserId: input.recipientUserId,
          byteLength: filled,
          contentSha256: createHash("sha256").update(delivered).digest("hex"),
          authorizationMode: input.authorizationMode,
          truncated,
          deliveredAt: now().toISOString(),
        },
      };
    } catch {
      return { code: "UNREADABLE" };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async verifyOpenedFile(
    requestedPath: string,
    openedStats: Stats,
  ): Promise<BrokerFailure | null> {
    let resolvedPath: string;
    let namedStats: Stats;
    try {
      resolvedPath = await realpath(requestedPath);
      if (isDeniedPath(resolvedPath, this.workspacePath)) {
        return { code: "SECRET_PATH" };
      }
      if (!(await this.boundary.contains({ workspacePath: resolvedPath }))) {
        return { code: "OUTSIDE_WORKSPACE" };
      }
      namedStats = await stat(resolvedPath);
    } catch {
      return { code: "UNREADABLE" };
    }

    // Matching both fields ties the validated name to the already-open file.
    // It catches a path that was swapped back inside after open as well as one
    // that changed while containment was being checked.
    if (
      !namedStats.isFile() ||
      namedStats.dev !== openedStats.dev ||
      namedStats.ino !== openedStats.ino
    ) {
      return { code: "OUTSIDE_WORKSPACE" };
    }
    return null;
  }
}

export function isLocatedResource(
  result: LocatedResource | BrokerFailure,
): result is LocatedResource {
  return "canonicalPath" in result;
}

export function isBrokerFailure(
  result: BrokeredRead | BrokerFailure,
): result is BrokerFailure {
  return "code" in result;
}
