#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { terminateProcessTree } from "./process-tree.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";

function npmArguments(args) {
  return npmCli ? [npmCli, ...args] : args;
}

const children = [
  start("server", ["run", "dev", "-w", "@launchpad/server"]),
  start("web", ["run", "dev", "-w", "@launchpad/web"]),
];
let stopping = false;

function start(name, args) {
  const child = spawn(command, npmArguments(args), {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  child.once("error", (error) => {
    process.stderr.write(`[dev] ${name} failed to start: ${error.message}\n`);
    shutdown(1);
  });
  child.once("exit", (code, signal) => {
    if (stopping) return;
    process.stderr.write(
      `[dev] ${name} stopped${signal ? ` (${signal})` : ` (exit ${code ?? 1})`}; stopping Telaegent.\n`,
    );
    shutdown(code ?? 1);
  });
  return child;
}

function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of children) terminateProcessTree(child);
  process.exitCode = exitCode;
}

process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(143));
process.once("SIGHUP", () => shutdown(129));
