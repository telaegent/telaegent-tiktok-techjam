import { describe, expect, it } from "vitest";
import { classifyProviderFailure } from "./runtime-errors.js";

describe("classifyProviderFailure", () => {
  it("classifies missing provider sessions without exposing provider output", () => {
    const error = classifyProviderFailure(
      "codex",
      "Failed to resume thread 0199: thread not found",
    );

    expect(error.code).toBe("RUNTIME_SESSION_NOT_FOUND");
    expect(error.message).toBe("Codex session is no longer available");
    expect(error.message).not.toContain("0199");
  });

  it("keeps authentication failures distinct from missing sessions", () => {
    expect(classifyProviderFailure("claude", "Login required").code).toBe(
      "RUNTIME_AUTHENTICATION_FAILED",
    );
  });
});
