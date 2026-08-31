import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const webPackage = JSON.parse(
  await readFile(new URL("../apps/web/package.json", import.meta.url), "utf8"),
);
const viteConfig = await readFile(
  new URL("../apps/web/vite.config.ts", import.meta.url),
  "utf8",
);

test("the development browser binds only to loopback", () => {
  assert.match(webPackage.scripts.dev, /--host 127\.0\.0\.1(?:\s|$)/u);
  assert.doesNotMatch(webPackage.scripts.dev, /0\.0\.0\.0|--host\s+(?:true|::)(?:\s|$)/u);
  assert.match(viteConfig, /host:\s*["']127\.0\.0\.1["']/u);
});
