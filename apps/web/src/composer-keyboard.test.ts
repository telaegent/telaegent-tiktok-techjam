import { describe, expect, it } from "vitest";
import { shouldSubmitComposerOnKeyDown } from "./composer-keyboard";

describe("message composer keyboard behavior", () => {
  it("submits on Enter", () => {
    expect(shouldSubmitComposerOnKeyDown({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
    })).toBe(true);
  });

  it("keeps Shift+Enter available for a newline", () => {
    expect(shouldSubmitComposerOnKeyDown({
      key: "Enter",
      shiftKey: true,
      isComposing: false,
    })).toBe(false);
  });

  it("does not submit while an input method is composing text", () => {
    expect(shouldSubmitComposerOnKeyDown({
      key: "Enter",
      shiftKey: false,
      isComposing: true,
    })).toBe(false);
  });

  it("ignores other keys", () => {
    expect(shouldSubmitComposerOnKeyDown({
      key: "ArrowDown",
      shiftKey: false,
      isComposing: false,
    })).toBe(false);
  });
});
