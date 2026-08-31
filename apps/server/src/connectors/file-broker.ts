import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import {
  RealpathWorkspaceBoundary,
  type WorkspaceBoundary,
} from "../authorization/workspace-boundary.js";
import { isDeniedPath, type ResourceDenyCode } from "./resource-policy.js";

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
      return {
        content: delivered.toString("utf8"),
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
}

export function isBrokerFailure(
  result: BrokeredRead | BrokerFailure,
): result is BrokerFailure {
  return "code" in result;
}
