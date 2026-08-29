import { defineConfig } from "vitest/config";

/**
 * The Phoenix demo fixture (apps/server/fixtures/phoenix) is a *sample repository*,
 * not part of this package. It ships its own tests, which are executed against a
 * copied Agent workspace by phoenix-fixture.ts, never as part of the server suite.
 *
 * Without this exclude, Vitest's default include glob collects
 * fixtures/phoenix/tests/**\/*.test.ts into `npm run test` and the fixture's
 * deliberately-changing Session contract breaks `npm run check`.  (Finding C1.)
 *
 * tsconfig.json already scopes typecheck to src/**, so no tsconfig change is needed.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**", "fixtures/**", "workspaces/**"],

    /**
     * The Phoenix fixture test spawns a nested Vitest process to run the
     * fixture's own suite (finding C3). While that child runs, the rest of the
     * suite is competing for the same cores, and tests that finish in
     * milliseconds on their own can exceed Vitest's 5s default — which shows up
     * as unrelated failures in other people's files.
     *
     * Nothing here is actually slow; the headroom is for contention. Left
     * parallel deliberately: serializing files would cost more than it buys.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
