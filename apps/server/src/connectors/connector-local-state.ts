import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { FileResourceRegistry, type ResourceRegistry } from "./resource-registry.js";
import {
  FileResourceTaskBudgetLedger,
  type ResourceTaskBudgetLedger,
} from "./resource-budget.js";
import {
  FileCapabilityGrantRevocationStore,
  type CapabilityGrantRevocationStore,
} from "./grant-revocations.js";

const connectorBindingIdSchema = z.string().uuid();

export interface ConnectorStateLocationOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
}

/**
 * Returns the current OS user's private application-state directory.
 *
 * This location is deliberately independent of the selected repository. A
 * registry contains canonical local paths, so placing it under the checkout
 * risks committing or uploading the very mapping the connector must keep
 * private. The environment is consulted only for standard OS state roots; no
 * cloud job or collaborator input can select this directory.
 */
export function connectorStateDirectory(
  options: ConnectorStateLocationOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const environment = options.environment ?? process.env;
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (!platformPath.isAbsolute(homeDirectory)) {
    throw new Error("Connector home directory must be absolute");
  }

  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA?.trim();
    const root = localAppData && path.win32.isAbsolute(localAppData)
      ? localAppData
      : path.win32.join(homeDirectory, "AppData", "Local");
    return path.win32.join(root, "Telaegent", "state");
  }

  if (platform === "darwin") {
    return path.posix.join(
      homeDirectory,
      "Library",
      "Application Support",
      "Telaegent",
      "state",
    );
  }

  const xdgStateHome = environment.XDG_STATE_HOME?.trim();
  const root = xdgStateHome && path.posix.isAbsolute(xdgStateHome)
    ? xdgStateHome
    : path.posix.join(homeDirectory, ".local", "state");
  return path.posix.join(root, "telaegent");
}

export interface ConnectorResourceRegistryOptions extends ConnectorStateLocationOptions {
  /** Test/packaging seam. Callers must still provide an absolute local path. */
  stateDirectory?: string;
}

/**
 * Creates the durable local registry for one opaque user x repository binding.
 *
 * The connector credential is intentionally absent: rotating a short-lived
 * bearer must not orphan an active task grant. A different binding receives a
 * different file, while the same binding reopens the same mapping after a
 * connector or cloud restart.
 */
export function createConnectorResourceRegistry(
  connectorBindingId: string,
  options: ConnectorResourceRegistryOptions = {},
): ResourceRegistry {
  const bindingId = connectorBindingIdSchema.parse(connectorBindingId);
  const stateDirectory = options.stateDirectory ?? connectorStateDirectory(options);
  if (!path.isAbsolute(stateDirectory)) {
    throw new Error("Connector state directory must be absolute");
  }
  return new FileResourceRegistry(
    path.join(stateDirectory, "resource-registries", `${bindingId}.json`),
  );
}

/**
 * Creates the durable task-wide byte/request ledger for one connector binding.
 * It intentionally shares the binding lifecycle with the resource registry so
 * neither a new HTTP batch nor a connector restart refills a live task.
 */
export function createConnectorResourceBudgetLedger(
  connectorBindingId: string,
  options: ConnectorResourceRegistryOptions = {},
): ResourceTaskBudgetLedger {
  const bindingId = connectorBindingIdSchema.parse(connectorBindingId);
  const stateDirectory = options.stateDirectory ?? connectorStateDirectory(options);
  if (!path.isAbsolute(stateDirectory)) {
    throw new Error("Connector state directory must be absolute");
  }
  return new FileResourceTaskBudgetLedger(
    path.join(stateDirectory, "resource-budgets", `${bindingId}.jsonl`),
  );
}

export function createConnectorGrantRevocationStore(
  connectorBindingId: string,
  options: ConnectorResourceRegistryOptions = {},
): CapabilityGrantRevocationStore {
  const bindingId = connectorBindingIdSchema.parse(connectorBindingId);
  const stateDirectory = options.stateDirectory ?? connectorStateDirectory(options);
  if (!path.isAbsolute(stateDirectory)) {
    throw new Error("Connector state directory must be absolute");
  }
  return new FileCapabilityGrantRevocationStore(
    path.join(stateDirectory, "grant-revocations", `${bindingId}.json`),
  );
}
