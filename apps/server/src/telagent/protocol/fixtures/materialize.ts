/**
 * FIXTURE MATERIALISATION — writes a fixture repository to disk.
 *
 * Two callers with different needs:
 *
 *   - deterministic tests, which want a tree in a temp directory and do not
 *     care whether it is a real Git repository;
 *   - live provider evaluation, which needs a real checkout because the whole
 *     point is to hand a CLI a working directory it can explore.
 *
 * Both go through `FileSystemPort` rather than `node:fs`. That is not ceremony:
 * the security suite proves `.env` is denied *before* it is opened, and that
 * proof only exists if every read is observable. A single direct `fs.readFile`
 * anywhere in this layer would make the claim unverifiable — which is finding
 * C7 from the earlier cross-file review, and the reason ports.ts exists.
 */

import type { FileSystemPort, GitPort } from "../../ports.js";
import { getFixtureRepo, type FixtureRepo, type FixtureRepoId } from "./repos.js";

/* ========================================================================== *
 * Path joining
 * ========================================================================== */

/**
 * Deliberately not `node:path`.
 *
 * Fixture paths are authored in this repository as POSIX literals, and the
 * output is fed to a port whose implementation may be a real filesystem or an
 * in-memory map. Using `path.join` here would make the in-memory implementation
 * behave differently on Windows than on Linux for no benefit — the paths are
 * ours, they are already normalised, and joining them is string work.
 */
function joinPosix(root: string, relative: string): string {
  const left = root.endsWith("/") ? root.slice(0, -1) : root;
  const right = relative.startsWith("/") ? relative.slice(1) : relative;
  return left + "/" + right;
}

function parentOf(posixPath: string): string | null {
  const index = posixPath.lastIndexOf("/");
  return index <= 0 ? null : posixPath.slice(0, index);
}

/* ========================================================================== *
 * Materialisation
 * ========================================================================== */

export interface MaterializedFixture {
  id: FixtureRepoId;
  /** Absolute path of the workspace root. */
  root: string;
  /** Workspace-relative paths written, in the order they were written. */
  written: string[];
}

/**
 * Writes one fixture tree under `root`.
 *
 * Idempotent by construction: every file is written unconditionally, so a
 * re-run repairs a tree an earlier failed run left half-built. It never
 * deletes, because a materialiser with delete permission over a caller-supplied
 * path is one bad argument away from removing something that matters. Cleanup
 * belongs to whoever created the temp directory and knows it is safe.
 */
export async function materializeFixture(
  fs: FileSystemPort,
  root: string,
  repo: FixtureRepo,
): Promise<MaterializedFixture> {
  await ensureDirectory(fs, root);

  const written: string[] = [];
  for (const file of repo.files) {
    const absolute = joinPosix(root, file.path);
    const parent = parentOf(absolute);
    if (parent !== null && parent !== root) await ensureDirectory(fs, parent);
    await fs.writeFile(absolute, file.content);
    written.push(file.path);
  }

  return { id: repo.id, root, written };
}

export async function materializeFixtureById(
  fs: FileSystemPort,
  root: string,
  id: FixtureRepoId,
): Promise<MaterializedFixture> {
  return materializeFixture(fs, root, getFixtureRepo(id));
}

/**
 * `mkdir -p` over a port that only offers a single-level `mkdir`.
 *
 * Walks from the top so each level exists before the next is attempted, and
 * tolerates a level that already exists — the ports contract does not promise
 * `EEXIST` semantics, and a fixture directory that is already there is the
 * normal case on re-run, not an error.
 */
async function ensureDirectory(fs: FileSystemPort, absolutePath: string): Promise<void> {
  const segments = absolutePath.split("/").filter((segment) => segment.length > 0);
  const isAbsolute = absolutePath.startsWith("/");

  let current = isAbsolute ? "" : ".";
  for (const segment of segments) {
    current = current === "" ? "/" + segment : current + "/" + segment;
    if (await fs.exists(current)) continue;
    try {
      await fs.mkdir(current);
    } catch {
      // Concurrent creation, or a path component that exists as something other
      // than a directory. The next write will fail with a clearer message than
      // anything that could be synthesised here.
    }
  }
}

/* ========================================================================== *
 * Git initialisation, for live evaluation only
 * ========================================================================== */

/**
 * Turns a materialised tree into a real Git repository with one commit.
 *
 * Needed only when a provider CLI will run against the tree: several of them
 * behave differently inside a repository than outside one, and `branch` and
 * `commit` in the protocol's project facts have to be real values or the
 * grounding cases are testing a fiction.
 *
 * Identity is set per-invocation with `-c` rather than written to the repo or
 * the developer's global config. A fixture that quietly edits `git config
 * --global user.email` during a hackathon is a debugging session nobody has
 * time for.
 *
 * `commit.gpgsign=false` matters for the same reason: a developer with commit
 * signing enabled globally would otherwise hit a signing prompt inside a test.
 */
export async function initFixtureGit(
  git: GitPort,
  root: string,
): Promise<{ branch: string; commit: string }> {
  const identity = [
    "-c",
    "user.name=Telaegent Fixture",
    "-c",
    "user.email=fixture@telaegent.invalid",
    "-c",
    "commit.gpgsign=false",
  ];

  await git(["init", "--initial-branch=main"], root);
  await git([...identity, "add", "-A"], root);
  await git([...identity, "commit", "-m", "fixture: initial tree"], root);

  const head = await git(["rev-parse", "HEAD"], root);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], root);

  return {
    branch: branch.stdout.trim() || "main",
    commit: head.stdout.trim(),
  };
}
