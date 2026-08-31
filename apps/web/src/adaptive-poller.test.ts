import { afterEach, describe, expect, it, vi } from "vitest";
import { AdaptivePoller, SingleFlightByKey } from "./adaptive-poller";

afterEach(() => {
  vi.useRealTimers();
});

describe("AdaptivePoller", () => {
  it("allows one request in flight and coalesces repeated refreshes", async () => {
    let finish: ((value: boolean) => void) | undefined;
    const poll = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const poller = new AdaptivePoller({ poll });

    poller.start();
    poller.refresh();
    poller.refresh();
    expect(poll).toHaveBeenCalledTimes(1);

    finish?.(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("backs off while idle, pauses, and refreshes immediately on resume", async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => false);
    const poller = new AdaptivePoller({
      poll,
      minimumDelayMs: 1_000,
      maximumDelayMs: 8_000,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);

    poller.setPaused(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(poll).toHaveBeenCalledTimes(2);
    poller.setPaused(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it("does not retain a queued refresh across a hidden-tab pause", async () => {
    let finish: ((value: boolean) => void) | undefined;
    const poll = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const poller = new AdaptivePoller({ poll });
    poller.start();
    poller.refresh();
    poller.setPaused(true);
    finish?.(false);
    await Promise.resolve();
    await Promise.resolve();

    poller.setPaused(false);
    expect(poll).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});

describe("SingleFlightByKey", () => {
  it("shares one request for the same scope but not across scopes", async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    const requests = new SingleFlightByKey<string>();
    const firstTask = vi.fn(() => new Promise<string>((resolve) => { resolveFirst = resolve; }));
    const secondTask = vi.fn(async () => "second");

    const first = requests.run("conversation-a", firstTask);
    const duplicate = requests.run("conversation-a", firstTask);
    const second = requests.run("conversation-b", secondTask);
    expect(first).toBe(duplicate);
    expect(firstTask).toHaveBeenCalledOnce();
    await expect(second).resolves.toBe("second");

    resolveFirst?.("first");
    await expect(first).resolves.toBe("first");
  });

  it("waits for an old flight and then performs an explicitly fresh request", async () => {
    let finish: ((value: string) => void) | undefined;
    const requests = new SingleFlightByKey<string>();
    const oldTask = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const freshTask = vi.fn(async () => "fresh");

    const old = requests.run("scope", oldTask);
    const fresh = requests.runFresh("scope", freshTask);
    expect(freshTask).not.toHaveBeenCalled();
    finish?.("old");
    await expect(old).resolves.toBe("old");
    await expect(fresh).resolves.toBe("fresh");
    expect(freshTask).toHaveBeenCalledOnce();
  });
});
