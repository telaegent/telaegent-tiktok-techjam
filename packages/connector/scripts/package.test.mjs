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

test("the packaged CLI accepts the current repository and command-line connection settings", async () => {
  const { parseConnectorCliOptions } = await import(
    "../dist/connectors/connector-cli-options.js"
  );
  assert.deepEqual(
    parseConnectorCliOptions([
      "connect",
      ".",
      "--url",
      "https://telaegent.live",
      "--instance-id",
      "connector-instance-id",
      "--credential",
      "connector-credential",
    ]),
    {
      workspaceCandidate: ".",
      provider: "auto",
      probeOnly: false,
      serverOrigin: "https://telaegent.live",
      connectorInstanceId: "connector-instance-id",
      credential: "connector-credential",
    },
  );
});
