import { describe, expect, it, vi } from "vitest";
import { runConnectorProbePump } from "./connector-probe-pump.js";

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) return rejectAbort();
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

describe("runConnectorProbePump", () => {
  it("keeps polling when an earlier delivery is not the probe job", async () => {
    let finishProbe!: (value: string) => void;
    const runProbe = vi.fn(async () => await new Promise<string>((resolve) => {
      finishProbe = resolve;
    }));
    const observedSignals: AbortSignal[] = [];
    const runOnce = vi.fn(async (signal: AbortSignal) => {
      observedSignals.push(signal);
      if (runOnce.mock.calls.length === 1) return "completed";
      finishProbe("ready");
      return await untilAborted(signal);
    });

    await expect(runConnectorProbePump(runOnce, runProbe)).resolves.toBe("ready");
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(observedSignals[0]).toBe(observedSignals[1]);
    expect(observedSignals[1]?.aborted).toBe(true);
  });

  it("aborts and joins connector polling when the cloud probe fails", async () => {
    let pollingFinished = false;
    const runOnce = vi.fn(async (signal: AbortSignal) => {
      try {
        return await untilAborted(signal);
      } finally {
        pollingFinished = true;
      }
    });

    await expect(runConnectorProbePump(
      runOnce,
      async () => { throw new Error("probe failed"); },
    )).rejects.toThrow("probe failed");
    expect(pollingFinished).toBe(true);
  });

  it("aborts and joins the cloud probe when connector polling fails", async () => {
    let probeFinished = false;
    const runProbe = vi.fn(async (signal: AbortSignal) => {
      try {
        return await untilAborted(signal);
      } finally {
        probeFinished = true;
      }
    });

    await expect(runConnectorProbePump(
      async () => { throw new Error("poll failed"); },
      runProbe,
    )).rejects.toThrow("poll failed");
    expect(probeFinished).toBe(true);
  });
});
