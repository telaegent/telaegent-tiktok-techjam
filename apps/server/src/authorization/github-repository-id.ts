import type { GitHubRepositoryId } from "./types.js";

const canonicalDecimalPattern = /^[1-9][0-9]{0,18}$/;
const maximumPostgresBigint = 9_223_372_036_854_775_807n;

/**
 * Canonical application representation for GitHub's numeric repository ID.
 *
 * PostgreSQL may store this value as BIGINT, but application and JSON
 * boundaries keep it as a decimal string so JavaScript cannot round it.
 */
export function isGitHubRepositoryId(value: unknown): value is GitHubRepositoryId {
  return (
    typeof value === "string" &&
    canonicalDecimalPattern.test(value) &&
    BigInt(value) <= maximumPostgresBigint
  );
}
