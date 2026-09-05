import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCapabilityGrantRevocationStore } from "./grant-revocations.js";

const directories: string[] = [];
const grantId = "30000000-0000-4000-8000-000000000001";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("connector-local capability revocations", () => {
  it("survives connector restart and prunes only after grant expiry", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "telaegent-revocations-"));
    directories.push(directory);
    const file = path.join(directory, "revocations.json");
    const first = new FileCapabilityGrantRevocationStore(file);
    await first.record([
      { grantId, expiresAt: "2026-09-05T03:00:00.000Z" },
    ], new Date("2026-09-05T01:00:00.000Z"));

    const restarted = new FileCapabilityGrantRevocationStore(file);
    await expect(
      restarted.isRevoked(grantId, new Date("2026-09-05T02:00:00.000Z")),
    ).resolves.toBe(true);
    await expect(
      restarted.isRevoked(grantId, new Date("2026-09-05T03:00:00.000Z")),
    ).resolves.toBe(false);
  });
});
