import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
const binPath = path.join(packageRoot, packageJson.bin.telaegent);
const webCommandPath = path.resolve(packageRoot, "../../apps/web/src/connector-command.ts");
const repositoryNodeModules = path.resolve(packageRoot, "../../node_modules");

test("the package launches with only its declared production dependencies", async () => {
  const contents = await readFile(binPath, "utf8");
  assert.ok(contents.startsWith("#!/usr/bin/env node\n"));

  // Run outside the workspace so Node cannot accidentally satisfy a missing
  // manifest entry from another workspace's hoisted dependencies. Linking only
  // the dependencies named by this package models what a clean npm install
  // makes directly resolvable without requiring registry access in the test.
  const installationRoot = await mkdtemp(path.join(os.tmpdir(), "telaegent-connector-"));
  const installedPackage = path.join(installationRoot, "package");
  try {
    await mkdir(installedPackage, { recursive: true });
    await cp(path.join(packageRoot, "dist"), path.join(installedPackage, "dist"), {
      recursive: true,
    });
    await cp(
      path.join(packageRoot, "package.json"),
      path.join(installedPackage, "package.json"),
    );
    const isolatedNodeModules = path.join(installedPackage, "node_modules");
    await mkdir(isolatedNodeModules, { recursive: true });
    for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
      const destination = path.join(isolatedNodeModules, ...dependency.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await symlink(
        path.join(repositoryNodeModules, ...dependency.split("/")),
        destination,
        process.platform === "win32" ? "junction" : "dir",
      );
    }

    const isolatedBin = path.join(installedPackage, packageJson.bin.telaegent);
    const result = spawnSync(process.execPath, [isolatedBin], {
      cwd: installedPackage,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: telaegent connect/);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
  } finally {
    await rm(installationRoot, { recursive: true, force: true });
  }
});

test("the packaged CLI accepts a one-time pairing code without a connector bearer", async () => {
  const { parseConnectorCliOptions } = await import(
    "../dist/connectors/connector-cli-options.js"
  );
  assert.deepEqual(
    parseConnectorCliOptions([
      "connect",
      ".",
      "--url",
      "https://telaegent.live",
      "--pair",
      "pairing-code",
    ]),
    {
      workspaceCandidate: ".",
      provider: "choose",
      probeOnly: false,
      serverOrigin: "https://telaegent.live",
      pairingCode: "pairing-code",
    },
  );
});

test("the website command pins the exact package release", async () => {
  const source = await readFile(webCommandPath, "utf8");
  assert.match(
    source,
    new RegExp(`${packageJson.name.replace("/", "\\/")}@${packageJson.version.replaceAll(".", "\\.")}`),
  );
});

test("the packaged CLI announces the providers that passed its live probes", async () => {
  const contents = await readFile(binPath, "utf8");
  assert.match(contents, /\{ providers: connectedProviders \}/);
  assert.doesNotMatch(
    contents,
    /bindings\/\$\{registered\.connectorBindingId\}\/ready`, \{\}/,
  );
});

test("the package excludes removed runtime schemas", async () => {
  await assert.rejects(
    readFile(
      path.join(
        packageRoot,
        "dist/telagent/output-schemas/connector-connection-probe.schema.json",
      ),
      "utf8",
    ),
    { code: "ENOENT" },
  );
});
