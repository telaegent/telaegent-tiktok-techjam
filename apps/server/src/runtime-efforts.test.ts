import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_EFFORT,
  RUNTIME_EFFORTS,
  UnsupportedEffortError,
  isSupportedEffort,
  resolveEffort,
} from "./runtime-efforts.js";
import { RUNTIME_MODELS } from "./runtime-models.js";

describe("runtime effort ladder", () => {
  it("offers only rungs a real turn was run on, on every model", () => {
    // Locked deliberately, like the model catalogue. These three cost 24 real
    // turns -- each rung against each entry of `RUNTIME_MODELS`, both providers
    // -- because codex-cli narrows the accepted set per model and neither CLI
    // falls back on a rung it dislikes. A rung added without that verification
    // should fail here and be verified rather than have the assertion updated.
    expect(RUNTIME_EFFORTS).toEqual(["low", "medium", "high"]);
  });

  it("means the same thing on both providers", () => {
    // The catalogue is per provider and this ladder is not, which is why the
    // API reports it once. If a rung ever becomes provider-specific it stops
    // belonging in this module.
    expect(Object.keys(RUNTIME_MODELS).length).toBeGreaterThan(1);
    expect(RUNTIME_EFFORTS).not.toContain("none");
    expect(RUNTIME_EFFORTS).not.toContain("minimal");
  });

  it("defaults to a rung it actually offers", () => {
    expect(isSupportedEffort(DEFAULT_RUNTIME_EFFORT)).toBe(true);
  });

  it("rejects everything outside the ladder, including argv-shaped input", () => {
    for (const value of [
      // Real values one CLI or the other takes, deliberately not offered:
      // `none` and `minimal` are Codex-side, `xhigh` and `max` are unverified.
      "none",
      "minimal",
      "xhigh",
      "max",
      "",
      " medium",
      "medium ",
      "MEDIUM",
      "--dangerously-skip-permissions",
      'medium" --sandbox danger-full-access',
      "medium\u0000", // a raw NUL, written as an escape so this file stays text
    ]) {
      expect(isSupportedEffort(value)).toBe(false);
    }
  });

  it("resolves an absent choice to the default without throwing", () => {
    expect(resolveEffort()).toBe("medium");
    expect(resolveEffort(undefined)).toBe("medium");
    expect(resolveEffort("")).toBe("medium");
    expect(resolveEffort("low")).toBe("low");
  });

  it("throws an error carrying no caller value", () => {
    let thrown: unknown;
    try {
      resolveEffort("xhigh");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedEffortError);
    expect((thrown as UnsupportedEffortError).code).toBe("UNSUPPORTED_RUNTIME_EFFORT");
    expect((thrown as Error).message).not.toContain("xhigh");
  });
});
