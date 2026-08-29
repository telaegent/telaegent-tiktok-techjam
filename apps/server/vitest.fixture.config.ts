import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Runs the Phoenix fixture's own tests inside a copied Agent workspace, using
 * this package's Vitest binary so the fixture needs no node_modules and no
 * network (finding C3). Point it at a workspace with VITEST_FIXTURE_ROOT.
 *
 * cacheDir is forced outside the workspace: Vite's default is
 * `<root>/node_modules/.vite`, which would create a node_modules directory
 * inside the Agent's workspace, appear in `git status --porcelain`, and then be
 * judged by the ownership gate as an unexpected change.
 */
const root = process.env.VITEST_FIXTURE_ROOT ?? "fixtures/phoenix";

export default defineConfig({
  root,
  cacheDir: path.join(tmpdir(), "telaegent-fixture-vite-cache"),
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    passWithNoTests: false,
  },
});
