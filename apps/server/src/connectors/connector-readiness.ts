/**
 * Refreshes an already-established readiness lease without taking a healthy
 * connector down for one transient control-plane failure.
 *
 * The initial readiness announcement remains a hard gate in the CLI. Once it
 * has succeeded, authenticated job polling is the authoritative liveness and
 * credential check; the periodic readiness marker is best-effort metadata.
 */
export async function refreshEstablishedReadiness(
  announceReady: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await announceReady();
    return true;
  } catch {
    return false;
  }
}
