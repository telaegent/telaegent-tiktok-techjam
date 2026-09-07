import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectorCredentialStore,
  type ConnectorCredentialVault,
} from "./connector-credential-store.js";

class MemoryVault implements ConnectorCredentialVault {
  readonly values = new Map<string, string>();
  async get(service: string, account: string) {
    return this.values.get(`${service}:${account}`) ?? null;
  }
  async set(service: string, account: string, secret: string) {
    this.values.set(`${service}:${account}`, secret);
  }
  async delete(service: string, account: string) {
    this.values.delete(`${service}:${account}`);
  }
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("connector credential store", () => {
  it("persists only installation metadata on disk and keeps the bearer in the vault", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "telaegent-credentials-"));
    temporaryDirectories.push(directory);
    const vault = new MemoryVault();
    const store = new ConnectorCredentialStore({ stateDirectory: directory, vault });
    const credential = "b".repeat(43);

    await expect(store.save("https://telaegent.live", {
      connectorInstanceId: "connector_instance_0001",
      credential,
    })).resolves.toBe(true);
    await expect(store.load("https://telaegent.live")).resolves.toEqual({
      connectorInstanceId: "connector_instance_0001",
      credential,
    });

    const metadata = await readFile(path.join(directory, "installations.json"), "utf8");
    expect(metadata).toContain("connector_instance_0001");
    expect(metadata).not.toContain(credential);

    await store.clear("https://telaegent.live");
    await expect(store.load("https://telaegent.live")).resolves.toBeNull();
    expect(vault.values.size).toBe(0);
  });

  it("does not write plaintext credentials when the system vault fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "telaegent-credentials-"));
    temporaryDirectories.push(directory);
    const vault: ConnectorCredentialVault = {
      async get() { return null; },
      async set() { throw new Error("vault unavailable"); },
      async delete() {},
    };
    const store = new ConnectorCredentialStore({ stateDirectory: directory, vault });
    await expect(store.save("https://telaegent.live", {
      connectorInstanceId: "connector_instance_0002",
      credential: "c".repeat(43),
    })).resolves.toBe(false);
    await expect(store.connectorInstanceId("https://telaegent.live")).resolves.toBeNull();
  });
});
