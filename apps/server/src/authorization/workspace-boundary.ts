import { realpath } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceBoundaryCheck {
  workspacePath: string;
}

/**
 * Resolves and checks a workspace path before execution.
 *
 * This runs connector-side. The cloud never sends or stores a local path; the
 * connector resolves its own binding and checks the result against this
 * boundary before invoking a local runner.
 */
export interface WorkspaceBoundary {
  contains(check: Readonly<WorkspaceBoundaryCheck>): Promise<boolean>;
}

/**
 * Filesystem-backed boundary that rejects traversal and symlink escapes.
 * Both paths must already exist; a missing workspace is not authorization.
 */
export class RealpathWorkspaceBoundary implements WorkspaceBoundary {
  constructor(private readonly workspaceRoot: string) {
    if (!path.isAbsolute(workspaceRoot)) {
      throw new Error("Workspace root must be absolute");
    }
  }

  async contains(check: Readonly<WorkspaceBoundaryCheck>): Promise<boolean> {
    if (!path.isAbsolute(check.workspacePath)) return false;
    try {
      const [root, candidate] = await Promise.all([
        realpath(this.workspaceRoot),
        realpath(check.workspacePath),
      ]);
      const relative = path.relative(root, candidate);
      return (
        relative.length > 0 &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    } catch {
      return false;
    }
  }
}

