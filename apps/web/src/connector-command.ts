import type { ConnectorCredential } from "./api";

export const connectorPackageSpec = "@telaegent/connector@0.1.0";

const urlSafeTokenPattern = /^[A-Za-z0-9_-]{16,128}$/;

export function buildConnectorCommand(
  origin: string,
  credential: ConnectorCredential,
): string {
  const serverOrigin = new URL(origin).origin;
  if (serverOrigin !== origin) {
    throw new Error("Connector URL must be an origin");
  }
  if (!urlSafeTokenPattern.test(credential.connectorInstanceId)) {
    throw new Error("Connector installation ID is invalid");
  }
  if (!urlSafeTokenPattern.test(credential.credential)) {
    throw new Error("Connector credential is invalid");
  }
  return [
    "npx",
    "--yes",
    connectorPackageSpec,
    "connect",
    ".",
    "--url",
    serverOrigin,
    "--instance-id",
    credential.connectorInstanceId,
    "--credential",
    credential.credential,
  ].join(" ");
}
