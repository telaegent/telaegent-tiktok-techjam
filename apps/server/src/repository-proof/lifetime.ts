/**
 * Cloud authorization deliberately expires local repository access proofs.
 * The connector must refresh well inside this window while it remains online.
 */
export const REPOSITORY_ACCESS_MAX_AGE_MS = 15 * 60 * 1_000;

/** Normal refresh cadence, leaving two additional attempts before expiry. */
export const REPOSITORY_REVALIDATION_INTERVAL_MS = 5 * 60 * 1_000;

/** Fast retry cadence after a transient local or control-plane failure. */
export const REPOSITORY_REVALIDATION_RETRY_MS = 15 * 1_000;
