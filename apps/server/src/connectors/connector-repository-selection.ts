import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Resolve a deliberately selected repository without silently climbing into
 * an ancestor checkout. The normal browser instruction says to `cd` to the
 * repository root, so accepting a nested non-repository folder would bind a
 * different scope from the one the human thought they selected.
 */
export async function resolveExactRepositoryRoot(candidate: string): Promise<string> {
  const selected = await realpath(path.resolve(candidate));
  const { stdout } = await execFileAsync(
    "git",
    ["-C", selected, "rev-parse", "--show-toplevel"],
    { encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true },
  );
  const root = await realpath(stdout.trim());
  if (path.relative(selected, root) !== "") {
    throw new Error(
      `Selected directory is not a Git repository root. Run the command from: ${root}`,
    );
  }
  return root;
}

export async function confirmRepositorySelection(
  repositoryFullName: string,
  workspacePath: string,
  ask: (prompt: string) => Promise<string> = askInTerminal,
): Promise<void> {
  const answer = (await ask(
    [
      "\nTELAEGENT REPOSITORY DETECTED",
      `GitHub: ${repositoryFullName}`,
      `Local root: ${workspacePath}`,
      "Connect this repository? [y/N] ",
    ].join("\n"),
  )).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    throw new Error("Repository connection cancelled; no pairing code was consumed");
  }
}

async function askInTerminal(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Repository confirmation requires an interactive terminal; no pairing code was consumed",
    );
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(prompt);
  } finally {
    terminal.close();
  }
}
