import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(serverRoot, "src", "telagent", "output-schemas");
const destination = resolve(serverRoot, "dist", "telagent", "output-schemas");

mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true, force: true });
