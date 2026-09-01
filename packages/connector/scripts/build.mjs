#!/usr/bin/env node

import { cp, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const serverDist = path.join(repositoryRoot, "apps", "server", "dist");
const packageDist = path.join(packageRoot, "dist");

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli
  ? process.execPath
  : process.platform === "win32"
    ? "npm.cmd"
    : "npm";
const npmArguments = npmCli
  ? [npmCli, "run", "build", "--workspace", "@launchpad/server"]
  : ["run", "build", "--workspace", "@launchpad/server"];
const build = spawnSync(
  npmCommand,
  npmArguments,
  {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

await rm(packageDist, { recursive: true, force: true });
await copyReachableModule("connectors/cli.js", new Set());
await cp(
  path.join(serverDist, "telagent", "output-schemas"),
  path.join(packageDist, "telagent", "output-schemas"),
  { recursive: true },
);

process.stdout.write("Built @telaegent/connector from the canonical connector runtime.\n");

async function copyReachableModule(relativePath, copied) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (copied.has(normalized)) return;
  copied.add(normalized);

  const source = path.join(serverDist, ...normalized.split("/"));
  const destination = path.join(packageDist, ...normalized.split("/"));
  const contents = await readFile(source, "utf8");
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);

  const importPattern = /(?:from\s+|import\s*)["'](\.\.?\/[^"']+\.js)["']/gu;
  for (const match of contents.matchAll(importPattern)) {
    const dependency = path.posix.normalize(
      path.posix.join(path.posix.dirname(normalized), match[1]),
    );
    if (dependency.startsWith("../") || path.posix.isAbsolute(dependency)) {
      throw new Error(`Connector build escaped the server distribution: ${dependency}`);
    }
    await copyReachableModule(dependency, copied);
  }
}
