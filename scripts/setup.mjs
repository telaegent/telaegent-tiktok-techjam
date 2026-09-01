#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectorValuesInApplicationEnvironment,
  inspectConnectorEnvironment,
  inspectEndToEndEnvironment,
  nodeMajor,
  parseEnvFile,
  renderConnectorEnv,
  renderLocalEnv,
} from "./setup-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const startAfterSetup = args.has("--start");
const strictEndToEnd = args.has("--strict-e2e");
const skipExternal = args.has("--skip-external");
const supportedArgs = new Set([
  "--check",
  "--start",
  "--strict-e2e",
  "--skip-external",
]);
for (const argument of args) {
  if (!supportedArgs.has(argument)) fail(`Unknown setup option: ${argument}`);
}

if (nodeMajor() < 22) fail(`Node.js 22+ is required; found ${process.version}`);
if (!new Set(["win32", "darwin", "linux"]).has(process.platform)) {
  fail(`Unsupported operating system: ${process.platform}`);
}

process.stdout.write(`[setup] Telaegent on ${process.platform}/${process.arch}, Node ${process.version}\n`);
const envContents = await ensureLocalEnvironment();
const connectorEnvContents = await ensureConnectorEnvironment();

if (!checkOnly) {
  runNpm(["ci"], "install locked dependencies");
  runNpm(["run", "build"], "build the browser and control plane");
}

const envProblems = inspectEndToEndEnvironment(parseEnvFile(envContents));
const connectorProblems = inspectConnectorEnvironment(parseEnvFile(connectorEnvContents));
const misplacedConnectorValues = connectorValuesInApplicationEnvironment(
  parseEnvFile(envContents),
).map((name) => `${name} must move from .env to connector.env`);
const external = skipExternal ? { problems: [], notes: [] } : inspectExternalTools();
const e2eProblems = [
  ...envProblems,
  ...misplacedConnectorValues,
  ...external.problems,
];

if (e2eProblems.length === 0) {
  process.stdout.write("[setup] Static configuration and command checks passed.\n");
} else {
  process.stdout.write("[setup] Local application setup is complete.\n");
  process.stdout.write("[setup] Full two-user end-to-end mode still needs:\n");
  for (const problem of e2eProblems) process.stdout.write(`  - ${problem}\n`);
  process.stdout.write("[setup] See docs/setup.md; rerun npm run doctor after completing these explicit external steps.\n");
  if (strictEndToEnd) process.exitCode = 2;
}
for (const note of external.notes) process.stdout.write(`[setup] ${note}\n`);
if (connectorProblems.length > 0) {
  process.stdout.write(
    "[setup] Source-checkout connector.env is not configured; this is optional when using the browser-generated npx pairing command.\n",
  );
}
process.stdout.write(
  "[setup] Live repository/provider/relay readiness is NOT verified by this command.\n" +
  "[setup] Normal users get the real live probe in the browser-generated npx connector command.\n" +
  "[setup] Source-checkout developers may use npm run doctor:live with connector.env.\n",
);

if (startAfterSetup && process.exitCode === undefined) {
  process.stdout.write("[setup] Starting Telaegent at http://localhost:5173\n");
  runNpm(["run", "dev"], "start Telaegent");
}

async function ensureLocalEnvironment() {
  const destination = path.join(repoRoot, ".env");
  try {
    const contents = await readFile(destination, "utf8");
    process.stdout.write("[setup] Keeping existing .env (never overwritten).\n");
    return contents;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const template = await readFile(path.join(repoRoot, ".env.example"), "utf8");
  const rendered = renderLocalEnv(template);
  if (checkOnly) {
    process.stdout.write("[setup] .env is absent; validating the generated local defaults without writing.\n");
    return rendered;
  }
  await writeFile(destination, rendered, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  if (process.platform !== "win32") await chmod(destination, 0o600);
  process.stdout.write("[setup] Created private .env with generated local secrets.\n");
  return rendered;
}

async function ensureConnectorEnvironment() {
  const destination = path.join(repoRoot, "connector.env");
  try {
    const contents = await readFile(destination, "utf8");
    process.stdout.write("[setup] Keeping existing connector.env (never overwritten).\n");
    return contents;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const template = await readFile(path.join(repoRoot, "connector.env.example"), "utf8");
  const rendered = renderConnectorEnv(template);
  if (checkOnly) {
    process.stdout.write(
      "[setup] connector.env is absent; validating generated connector defaults without writing.\n",
    );
    return rendered;
  }
  await writeFile(destination, rendered, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  if (process.platform !== "win32") await chmod(destination, 0o600);
  process.stdout.write(
    "[setup] Created private connector.env; only connector commands load it.\n",
  );
  return rendered;
}

function inspectExternalTools() {
  const problems = [];
  const notes = [];
  if (!commandSucceeds("git", ["--version"])) problems.push("install Git");
  if (!commandSucceeds("gh", ["--version"])) {
    problems.push("install GitHub CLI (gh)");
  } else if (!commandSucceeds("gh", ["auth", "status"])) {
    problems.push("run gh auth login locally");
  }
  const codexInstalled = commandSucceeds("codex", ["--version"]);
  const claudeInstalled = commandSucceeds("claude", ["--version"]);
  if (!codexInstalled && !claudeInstalled) {
    problems.push("install Codex CLI or Claude Code CLI");
  } else {
    const installed = [codexInstalled ? "Codex" : "", claudeInstalled ? "Claude" : ""]
      .filter(Boolean)
      .join(" and ");
    notes.push(
      `${installed} CLI installation detected; authentication and model access remain live-unverified.`,
    );
  }
  return { problems, notes };
}

function commandSucceeds(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

function runNpm(npmArgs, description) {
  process.stdout.write(`[setup] ${description}...\n`);
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = npmCli ? [npmCli, ...npmArgs] : npmArgs;
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) fail(`${description} failed: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function fail(message) {
  process.stderr.write(`[setup] ${message}\n`);
  process.exit(1);
}
