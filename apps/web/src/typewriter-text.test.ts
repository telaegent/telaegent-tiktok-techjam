import { describe, expect, it } from "vitest";
import {
  splitTypewriterText,
  typewriterDurationMs,
  typewriterVisibleCount,
} from "./typewriter-text";

describe("typewriter text", () => {
  it("keeps user-perceived characters together", () => {
    expect(splitTypewriterText("Ship 👩🏽‍💻 safely")).toEqual([
      "S", "h", "i", "p", " ", "👩🏽‍💻", " ", "s", "a", "f", "e", "l", "y",
    ]);
  });

  it("keeps short responses readable and caps long response delays", () => {
    expect(typewriterDurationMs(1)).toBe(360);
    expect(typewriterDurationMs(100)).toBe(1_800);
    expect(typewriterDurationMs(10_000)).toBe(2_400);
  });

  it("reveals a monotonic bounded character count", () => {
    expect(typewriterVisibleCount(-1, 1_000, 20)).toBe(0);
    expect(typewriterVisibleCount(250, 1_000, 20)).toBe(5);
    expect(typewriterVisibleCount(2_000, 1_000, 20)).toBe(20);
    expect(typewriterVisibleCount(10, 0, 20)).toBe(20);
  });
});
