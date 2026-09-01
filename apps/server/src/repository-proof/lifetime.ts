/**
 * Cloud authorization deliberately expires local repository access proofs.
 * The connector must refresh well inside this window while it remains online.
 */
export const REPOSITORY_ACCESS_MAX_AGE_MS = 15 * 60 * 1_000;

/** Future-timestamp tolerance used by private-runtime authorization. */
export const REPOSITORY_ACCESS_MAXIMUM_CLOCK_SKEW_MS = 60 * 1_000;

/** Normal refresh cadence, leaving two additional attempts before expiry. */
export const REPOSITORY_REVALIDATION_INTERVAL_MS = 5 * 60 * 1_000;

/** Fast retry cadence after a transient local or control-plane failure. */
export const REPOSITORY_REVALIDATION_RETRY_MS = 15 * 1_000;

/**
 * One source of truth for the server's repository-access freshness decision.
 * Callers may supply an explicit policy only when composing an authorizer with
 * a deliberate non-default policy (primarily focused tests).
 */
export function repositoryAccessProofIsFresh(
  verifiedAt: string,
  nowMs: number,
  maximumAgeMs = REPOSITORY_ACCESS_MAX_AGE_MS,
  maximumClockSkewMs = REPOSITORY_ACCESS_MAXIMUM_CLOCK_SKEW_MS,
): boolean {
  const verifiedAtMs = Date.parse(verifiedAt);
  return (
    Number.isFinite(verifiedAtMs) &&
    Number.isFinite(nowMs) &&
    verifiedAtMs <= nowMs + maximumClockSkewMs &&
    nowMs - verifiedAtMs <= maximumAgeMs
  );
}
