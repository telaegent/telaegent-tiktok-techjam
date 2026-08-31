import { describe, expect, it } from "vitest";
import { isGitHubRepositoryId } from "./index.js";

describe("isGitHubRepositoryId", () => {
  it.each(["1", "1345851083", "9223372036854775807"])(
    "accepts canonical PostgreSQL BIGINT value %s",
    (value) => {
      expect(isGitHubRepositoryId(value)).toBe(true);
    },
  );

  it.each([
    1345851083,
    "",
    "0",
    "-1",
    "+1",
    "01",
    "1.0",
    "1e3",
    " 1",
    "9223372036854775808",
    "99999999999999999999",
  ])("rejects non-canonical or out-of-range value %s", (value) => {
    expect(isGitHubRepositoryId(value)).toBe(false);
  });
});
