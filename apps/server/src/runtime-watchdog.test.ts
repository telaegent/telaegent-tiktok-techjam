import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeWatchdog } from "./runtime-watchdog.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("RuntimeWatchdog", () => {
  it("times out after the configured period without provider activity", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    new RuntimeWatchdog(60_000, 300_000, onTimeout);

    vi.advanceTimersByTime(59_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onTimeout).toHaveBeenCalledWith("idle");
  });

  it("resets only the idle limit when output arrives", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const watchdog = new RuntimeWatchdog(60_000, 300_000, onTimeout);

    for (let elapsed = 0; elapsed < 240_000; elapsed += 30_000) {
      vi.advanceTimersByTime(30_000);
      watchdog.activity();
    }
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onTimeout).toHaveBeenCalledWith("maximum");
  });

  it("does nothing after a completed process stops the watchdog", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const watchdog = new RuntimeWatchdog(60_000, 300_000, onTimeout);

    watchdog.stop();
    vi.advanceTimersByTime(300_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
