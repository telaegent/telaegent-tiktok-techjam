import { describe, expect, it } from "vitest";
import {
  REPOSITORY_ACCESS_MAX_AGE_MS,
  REPOSITORY_ACCESS_MAXIMUM_CLOCK_SKEW_MS,
  repositoryAccessProofIsFresh,
} from "./lifetime.js";

describe("repositoryAccessProofIsFresh", () => {
  const nowMs = Date.parse("2026-09-02T00:00:00.000Z");

  it("matches the private-runtime age boundary", () => {
    expect(
      repositoryAccessProofIsFresh(
        new Date(nowMs - REPOSITORY_ACCESS_MAX_AGE_MS).toISOString(),
        nowMs,
      ),
    ).toBe(true);
    expect(
      repositoryAccessProofIsFresh(
        new Date(nowMs - REPOSITORY_ACCESS_MAX_AGE_MS - 1).toISOString(),
        nowMs,
      ),
    ).toBe(false);
  });

  it("rejects invalid and excessively future timestamps", () => {
    expect(repositoryAccessProofIsFresh("invalid", nowMs)).toBe(false);
    expect(
      repositoryAccessProofIsFresh(
        new Date(
          nowMs + REPOSITORY_ACCESS_MAXIMUM_CLOCK_SKEW_MS + 1,
        ).toISOString(),
        nowMs,
      ),
    ).toBe(false);
  });
});
