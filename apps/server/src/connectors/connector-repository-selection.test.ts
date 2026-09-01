import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  confirmRepositorySelection,
  resolveExactRepositoryRoot,
} from "./connector-repository-selection.js";

const execFileAsync = promisify(execFile);

describe("connector repository selection", () => {
  it("accepts the exact Git root but rejects a nested folder before pairing", async () => {
    const testRoot = await mkdtemp(path.join(tmpdir(), "telaegent-repository-selection-"));
    try {
      const repository = path.join(testRoot, "repository");
      const misleadingChild = path.join(repository, "tiktok-techjam-test");
      await mkdir(misleadingChild, { recursive: true });
      await execFileAsync(
        "git",
        ["init", "--quiet", "--initial-branch=main", repository],
        { windowsHide: true },
      );

      await expect(resolveExactRepositoryRoot(repository)).resolves.toBe(
        await realpath(repository),
      );
      await expect(resolveExactRepositoryRoot(misleadingChild)).rejects.toThrow(
        "Selected directory is not a Git repository root",
      );
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("requires an explicit yes for the resolved GitHub repository", async () => {
    let renderedPrompt = "";
    await expect(
      confirmRepositorySelection(
        "telaegent/telaegent-tiktok-techjam",
        "D:\\repo",
        async (prompt) => {
          renderedPrompt = prompt;
          return "yes";
        },
      ),
    ).resolves.toBeUndefined();
    expect(renderedPrompt).toContain("GitHub: telaegent/telaegent-tiktok-techjam");
    expect(renderedPrompt).toContain("Local root: D:\\repo");

    for (const answer of ["", "n", "anything else"]) {
      await expect(
        confirmRepositorySelection("owner/test", "/repo", async () => answer),
      ).rejects.toThrow("no pairing code was consumed");
    }
  });
});
