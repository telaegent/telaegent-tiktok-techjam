import { FileResourceRegistry } from "../resource-registry.ts";

const [registryPath, taskId, canonicalPath] = process.argv.slice(2);
if (!registryPath || !taskId || !canonicalPath) {
  throw new Error("Resource registry child arguments are missing");
}

const registry = new FileResourceRegistry(registryPath);
process.stdout.write(await registry.mint(taskId, canonicalPath));
