import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { connectorStateDirectory, type ConnectorStateLocationOptions } from "./connector-local-state.js";

const installationSchema = z.strictObject({
  connectorInstanceId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
});
const metadataSchema = z.strictObject({
  version: z.literal(1),
  origins: z.record(z.string().url(), installationSchema),
});
const credentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export type StoredConnectorCredential = {
  connectorInstanceId: string;
  credential: string;
};

export interface ConnectorCredentialVault {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

export interface ConnectorCredentialStoreOptions extends ConnectorStateLocationOptions {
  stateDirectory?: string;
  vault?: ConnectorCredentialVault;
}

const SERVICE = "Telaegent Connector";

export class ConnectorCredentialStore {
  private readonly metadataPath: string;
  private readonly vault: ConnectorCredentialVault;

  constructor(options: ConnectorCredentialStoreOptions = {}) {
    const stateDirectory = options.stateDirectory ?? connectorStateDirectory(options);
    if (!path.isAbsolute(stateDirectory)) throw new Error("Connector state directory must be absolute");
    this.metadataPath = path.join(stateDirectory, "installations.json");
    this.vault = options.vault ?? new SystemConnectorCredentialVault();
  }

  async load(origin: string): Promise<StoredConnectorCredential | null> {
    const normalizedOrigin = normalizeOrigin(origin);
    const metadata = await this.readMetadata();
    const installation = metadata.origins[normalizedOrigin];
    if (!installation) return null;
    try {
      const credential = await this.vault.get(
        SERVICE,
        vaultAccount(normalizedOrigin, installation.connectorInstanceId),
      );
      if (!credential) return null;
      return {
        connectorInstanceId: installation.connectorInstanceId,
        credential: credentialSchema.parse(credential),
      };
    } catch {
      return null;
    }
  }

  async save(origin: string, value: StoredConnectorCredential): Promise<boolean> {
    const normalizedOrigin = normalizeOrigin(origin);
    const parsed = {
      connectorInstanceId: installationSchema.shape.connectorInstanceId.parse(
        value.connectorInstanceId,
      ),
      credential: credentialSchema.parse(value.credential),
    };
    try {
      await this.vault.set(
        SERVICE,
        vaultAccount(normalizedOrigin, parsed.connectorInstanceId),
        parsed.credential,
      );
      const metadata = await this.readMetadata();
      const previous = metadata.origins[normalizedOrigin];
      metadata.origins[normalizedOrigin] = {
        connectorInstanceId: parsed.connectorInstanceId,
      };
      await this.writeMetadata(metadata);
      if (previous && previous.connectorInstanceId !== parsed.connectorInstanceId) {
        await this.vault.delete(
          SERVICE,
          vaultAccount(normalizedOrigin, previous.connectorInstanceId),
        ).catch(() => undefined);
      }
      return true;
    } catch {
      return false;
    }
  }

  async clear(origin: string): Promise<void> {
    const normalizedOrigin = normalizeOrigin(origin);
    const metadata = await this.readMetadata();
    const installation = metadata.origins[normalizedOrigin];
    if (!installation) return;
    await this.vault.delete(
      SERVICE,
      vaultAccount(normalizedOrigin, installation.connectorInstanceId),
    ).catch(() => undefined);
    delete metadata.origins[normalizedOrigin];
    await this.writeMetadata(metadata);
  }

  async connectorInstanceId(origin: string): Promise<string | null> {
    const metadata = await this.readMetadata();
    return metadata.origins[normalizeOrigin(origin)]?.connectorInstanceId ?? null;
  }

  private async readMetadata(): Promise<z.infer<typeof metadataSchema>> {
    try {
      return metadataSchema.parse(JSON.parse(await readFile(this.metadataPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { version: 1, origins: {} };
      }
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new Error("Telaegent installation metadata is invalid");
      }
      throw error;
    }
  }

  private async writeMetadata(metadata: z.infer<typeof metadataSchema>): Promise<void> {
    await mkdir(path.dirname(this.metadataPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.metadataPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(metadata), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.metadataPath);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

class SystemConnectorCredentialVault implements ConnectorCredentialVault {
  async get(service: string, account: string): Promise<string | null> {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return (await new AsyncEntry(service, account).getPassword()) ?? null;
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    await new AsyncEntry(service, account).setPassword(secret);
  }

  async delete(service: string, account: string): Promise<void> {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    await new AsyncEntry(service, account).deleteCredential();
  }
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password) {
    throw new Error("Telaegent URL must be an origin");
  }
  return url.origin;
}

function vaultAccount(origin: string, connectorInstanceId: string): string {
  return `${origin}|${connectorInstanceId}`;
}
