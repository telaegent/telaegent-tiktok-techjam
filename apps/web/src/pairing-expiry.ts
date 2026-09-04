export const CONNECTOR_PAIRING_POLL_INTERVAL_MS = 1_500;

export type ConnectorCredentialLease = Readonly<{
  status: "active" | "expired" | "revoked";
  expiresAt: string;
}>;

/** Returns null once a pairing is unusable; otherwise the next bounded delay. */
export function nextPairingPollDelay(
  expiresAt: string,
  nowMs = Date.now(),
): number | null {
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return null;
  return Math.min(CONNECTOR_PAIRING_POLL_INTERVAL_MS, expiresMs - nowMs);
}

/**
 * Polls against the short-lived pairing until it is exchanged, then against
 * the longer-lived connector credential issued by that exchange.
 */
export function nextConnectorSetupPollDelay(
  pairingExpiresAt: string,
  credential: ConnectorCredentialLease | null,
  nowMs = Date.now(),
): number | null {
  if (credential === null) {
    return nextPairingPollDelay(pairingExpiresAt, nowMs);
  }
  if (credential.status !== "active") return null;
  return nextPairingPollDelay(credential.expiresAt, nowMs);
}
