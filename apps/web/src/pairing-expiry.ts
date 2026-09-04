export const CONNECTOR_PAIRING_POLL_INTERVAL_MS = 1_500;

/** Returns null once a pairing is unusable; otherwise the next bounded delay. */
export function nextPairingPollDelay(
  expiresAt: string,
  nowMs = Date.now(),
): number | null {
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return null;
  return Math.min(CONNECTOR_PAIRING_POLL_INTERVAL_MS, expiresMs - nowMs);
}
