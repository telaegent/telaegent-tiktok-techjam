import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectorStateDirectory,
  createConnectorResourceRegistry,
} from "./connector-local-state.js";

const bindingA = "50000000-0000-4000-8000-000000000005";
const bindingB = "50000000-0000-4000-8000-000000000006";
const taskId = "task-local-state";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryStateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "telaegent-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("connector local state location", () => {
  it("uses the current Windows user's application-data directory", () => {
    expect(
      connectorStateDirectory({
        platform: "win32",
        homeDirectory: "C:\\Users\\owner",
        environment: { LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" },
      }),
    ).toBe("C:\\Users\\owner\\AppData\\Local\\Telaegent\\state");
  });

  it("uses platform state conventions and ignores a relative XDG override", () => {
    expect(
      connectorStateDirectory({
        platform: "darwin",
        homeDirectory: "/Users/owner",
        environment: {},
      }),
    ).toBe("/Users/owner/Library/Application Support/Telaegent/state");
    expect(
      connectorStateDirectory({
        platform: "linux",
        homeDirectory: "/home/owner",
        environment: { XDG_STATE_HOME: "relative/state" },
      }),
    ).toBe("/home/owner/.local/state/telaegent");
  });

  it("rejects paths and binding identifiers that could escape the state root", () => {
    expect(() =>
      createConnectorResourceRegistry("../../another-repository", {
        stateDirectory: path.resolve("state"),
      }),
    ).toThrow();
    expect(() =>
      createConnectorResourceRegistry(bindingA, { stateDirectory: "relative-state" }),
    ).toThrow("Connector state directory must be absolute");
  });
});

describe("binding-scoped connector resource registry", () => {
  it("survives restart for the same binding without depending on a credential", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const canonicalPath = path.resolve(stateDirectory, "workspace", "src", "answer.ts");
    const first = createConnectorResourceRegistry(bindingA, { stateDirectory });
    const resourceId = await first.mint(taskId, canonicalPath);

    const restarted = createConnectorResourceRegistry(bindingA, { stateDirectory });
    await expect(restarted.resolve(taskId, resourceId)).resolves.toBe(canonicalPath);
  });

  it("atomically preserves multiple mappings across successive writes", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const registry = createConnectorResourceRegistry(bindingA, { stateDirectory });
    const firstPath = path.resolve(stateDirectory, "workspace", "src", "first.ts");
    const secondPath = path.resolve(stateDirectory, "workspace", "src", "second.ts");
    const firstId = await registry.mint(taskId, firstPath);
    const secondId = await registry.mint(taskId, secondPath);

    const restarted = createConnectorResourceRegistry(bindingA, { stateDirectory });
    await expect(restarted.resolve(taskId, firstId)).resolves.toBe(firstPath);
    await expect(restarted.resolve(taskId, secondId)).resolves.toBe(secondPath);
  });

  it("isolates two user x repository bindings even for the same task and path", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const canonicalPath = path.resolve(stateDirectory, "workspace", "src", "answer.ts");
    const first = createConnectorResourceRegistry(bindingA, { stateDirectory });
    const second = createConnectorResourceRegistry(bindingB, { stateDirectory });
    const firstResourceId = await first.mint(taskId, canonicalPath);
    const secondResourceId = await second.mint(taskId, canonicalPath);

    expect(secondResourceId).not.toBe(firstResourceId);
    await expect(second.resolve(taskId, firstResourceId)).resolves.toBeNull();
    await expect(first.resolve(taskId, secondResourceId)).resolves.toBeNull();
  });

  it("keeps canonical paths only in the local owner-only state file", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const canonicalPath = path.resolve(stateDirectory, "workspace", "src", "answer.ts");
    const registry = createConnectorResourceRegistry(bindingA, { stateDirectory });
    const resourceId = await registry.mint(taskId, canonicalPath);
    const registryFile = path.join(
      stateDirectory,
      "resource-registries",
      `${bindingA}.json`,
    );
    const storedResource = path.join(
      `${registryFile}.entries`,
      "by-resource",
      `${resourceId}.json`,
    );
    const stored = JSON.parse(await readFile(storedResource, "utf8")) as {
      canonicalPath: string;
    };

    expect(stored.canonicalPath).toBe(canonicalPath);
    expect(resourceId).not.toContain("answer");
    expect(resourceId).not.toContain(stateDirectory);
    if (process.platform !== "win32") {
      expect((await stat(storedResource)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(storedResource))).mode & 0o777).toBe(0o700);
    }
  });

  it("fails closed when this binding's durable state is corrupt", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const registry = createConnectorResourceRegistry(bindingA, { stateDirectory });
    const resourceId = await registry.mint(
      taskId,
      path.resolve(stateDirectory, "workspace", "answer.ts"),
    );
    const registryFile = path.join(
      stateDirectory,
      "resource-registries",
      `${bindingA}.json`,
    );
    const storedResource = path.join(
      `${registryFile}.entries`,
      "by-resource",
      `${resourceId}.json`,
    );
    await writeFile(storedResource, "{}");

    const restarted = createConnectorResourceRegistry(bindingA, { stateDirectory });
    await expect(restarted.resolve(taskId, resourceId)).rejects.toThrow(
      "Resource registry is unreadable",
    );
  });
});
