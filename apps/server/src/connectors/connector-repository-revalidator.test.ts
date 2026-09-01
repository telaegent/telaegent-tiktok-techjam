import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorRepositoryRevalidator } from "./connector-repository-revalidator.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ConnectorRepositoryRevalidator", () => {
  it("refreshes periodically without running at startup twice", async () => {
    vi.useFakeTimers();
    const refreshProof = vi.fn().mockResolvedValue(undefined);
    const revalidator = new ConnectorRepositoryRevalidator(refreshProof, {
      refreshIntervalMs: 5_000,
      retryIntervalMs: 1_000,
    });

    revalidator.start();
    expect(refreshProof).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(refreshProof).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshProof).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshProof).toHaveBeenCalledTimes(2);
    revalidator.stop();
  });

  it("retries transient failures quickly and reports recovery", async () => {
    vi.useFakeTimers();
    const refreshProof = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue(undefined);
    const onRetry = vi.fn();
    const onRecovered = vi.fn();
    const revalidator = new ConnectorRepositoryRevalidator(refreshProof, {
      refreshIntervalMs: 5_000,
      retryIntervalMs: 1_000,
      onRetry,
      onRecovered,
    });

    revalidator.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, delayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshProof).toHaveBeenCalledTimes(2);
    expect(onRecovered).toHaveBeenCalledWith({ attempts: 1 });
    revalidator.stop();
  });

  it("keeps concurrent recovery triggers single-flight", async () => {
    let finish!: () => void;
    const refreshProof = vi.fn(
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const revalidator = new ConnectorRepositoryRevalidator(refreshProof, {
      refreshIntervalMs: 5_000,
      retryIntervalMs: 1_000,
    });
    revalidator.start();

    const first = revalidator.refresh();
    const second = revalidator.refresh();
    expect(first).toBe(second);
    expect(refreshProof).toHaveBeenCalledOnce();
    finish();
    await expect(first).resolves.toBe(true);
    revalidator.stop();
  });

  it("stops scheduling after shutdown", async () => {
    vi.useFakeTimers();
    const refreshProof = vi.fn().mockResolvedValue(undefined);
    const revalidator = new ConnectorRepositoryRevalidator(refreshProof, {
      refreshIntervalMs: 5_000,
      retryIntervalMs: 1_000,
    });

    revalidator.start();
    revalidator.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshProof).not.toHaveBeenCalled();
  });
});
