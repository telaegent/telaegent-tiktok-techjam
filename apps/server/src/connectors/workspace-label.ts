import path from "node:path";
import { resourceDisplayLabelSchema } from "./resource-request.js";

/**
 * The single containment check for anything derived from a local path that a
 * human or the cloud will see.
 *
 * Returns a workspace-relative label, or null when the path resolves anywhere
 * else. Null is the safe answer and every caller must treat it as "say
 * nothing" rather than falling back to the original value.
 */
export function projectRelativeDisplayLabel(
  workspacePath: string,
  canonicalPath: string,
): string | null {
  const relative = path.relative(path.resolve(workspacePath), path.resolve(canonicalPath));
  if (!relative || path.isAbsolute(relative)) return null;
  const label = relative.split(path.sep).join("/");
  const parsed = resourceDisplayLabelSchema.safeParse(label);
  return parsed.success ? parsed.data : null;
}
