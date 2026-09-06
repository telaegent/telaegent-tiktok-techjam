import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_MODEL,
  RUNTIME_MODELS,
  UnsupportedModelError,
  isSupportedModel,
  resolveModel,
} from "./runtime-models.js";

describe("runtime model catalogue", () => {
  it("offers only models a hello turn was actually run on", () => {
    // Locked deliberately. Every entry cost one real turn through the
    // production flag surface; a model added without that verification should
    // fail here and be verified rather than have the assertion updated.
    expect(RUNTIME_MODELS.claude).toEqual(["opus", "sonnet", "haiku", "fable"]);
    expect(RUNTIME_MODELS.codex).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
  });

  it("defaults to a model each provider actually offers", () => {
    for (const provider of ["claude", "codex"] as const) {
      expect(isSupportedModel(provider, DEFAULT_RUNTIME_MODEL[provider])).toBe(true);
    }
  });

  it("keeps the two catalogues apart", () => {
    // The allowlist is per provider, not a union. A Codex model requested on a
    // Claude turn is a caller error, not a silent fallback.
    expect(isSupportedModel("claude", "gpt-6-astra")).toBe(false);
    expect(isSupportedModel("codex", "opus")).toBe(false);
  });

  it("rejects everything outside the catalogue, including argv-shaped input", () => {
    for (const value of [
      "not-a-real-model",
      "",
      " opus",
      "opus ",
      "OPUS",
      "--dangerously-skip-permissions",
      "opus --model sonnet",
      "opus\u0000", // a raw NUL, written as an escape so this file stays text
    ]) {
      expect(isSupportedModel("claude", value)).toBe(false);
    }
  });

  it("resolves an absent choice to the default without throwing", () => {
    expect(resolveModel("claude")).toBe("opus");
    expect(resolveModel("claude", undefined)).toBe("opus");
    expect(resolveModel("codex", "")).toBe("gpt-5.6-sol");
    expect(resolveModel("codex", "gpt-5.5")).toBe("gpt-5.5");
  });

  it("throws an error carrying no caller value", () => {
    let thrown: unknown;
    try {
      resolveModel("claude", "gpt-6-astra");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedModelError);
    expect((thrown as UnsupportedModelError).code).toBe("UNSUPPORTED_RUNTIME_MODEL");
    expect((thrown as Error).message).not.toContain("gpt-6-astra");
  });
});
