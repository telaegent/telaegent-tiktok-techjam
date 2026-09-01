import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
const binPath = path.join(packageRoot, packageJson.bin.telaegent);
const webCommandPath = path.resolve(packageRoot, "../../apps/web/src/connector-command.ts");

test("the package exposes an executable Telaegent connector", async () => {
  const contents = await readFile(binPath, "utf8");
  assert.ok(contents.startsWith("#!/usr/bin/env node\n"));

  const result = spawnSync(process.execPath, [binPath], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: telaegent connect/);
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
      provider: "auto",
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
