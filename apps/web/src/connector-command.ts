import type { ConnectorPairing } from "./api";

export const connectorPackageSpec = "@telaegent/connector@0.1.10";

const urlSafeTokenPattern = /^[A-Za-z0-9_-]{16,128}$/;

export function buildConnectorCommand(
  origin: string,
  pairing: ConnectorPairing,
): string {
  const serverOrigin = new URL(origin).origin;
  if (serverOrigin !== origin) {
    throw new Error("Connector URL must be an origin");
  }
  if (!urlSafeTokenPattern.test(pairing.connectorInstanceId)) {
    throw new Error("Connector installation ID is invalid");
  }
  if (!urlSafeTokenPattern.test(pairing.pairingCode)) {
    throw new Error("Connector pairing code is invalid");
  }
  return [
    "npx",
    "--yes",
    connectorPackageSpec,
    "connect",
    ".",
    "--url",
    serverOrigin,
    "--pair",
    pairing.pairingCode,
  ].join(" ");
}
