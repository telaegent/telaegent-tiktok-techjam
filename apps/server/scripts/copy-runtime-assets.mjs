import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(serverRoot, "src", "telagent", "output-schemas");
const destination = resolve(serverRoot, "dist", "telagent", "output-schemas");

// The TypeScript compiler does not clean dist. Replace the asset directory so
// a deleted schema cannot survive from an older build into a connector tarball.
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
// Schemas only. A colocated test beside a schema is source, not a runtime
// asset, and must not reach a published connector tarball.
cpSync(source, destination, {
  recursive: true,
  force: true,
  filter: (entry) => statSync(entry).isDirectory() || entry.endsWith(".json"),
});
