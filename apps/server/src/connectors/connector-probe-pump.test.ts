import { describe, expect, it, vi } from "vitest";
import {
  ConnectorPollingFailedError,
  runConnectorProbePump,
} from "./connector-probe-pump.js";
import {
  probeFailureReason,
  probeFailureSource,
} from "./connector-probe-failure.js";

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

    await expect(runConnectorProbePump(
      runOnce,
      runProbe,
      async (value) => value,
    )).resolves.toBe("ready");
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(observedSignals[0]).toBe(observedSignals[1]);
    expect(observedSignals[1]?.aborted).toBe(true);
  });

  it("keeps a successful probe signal live until its returned body is consumed", async () => {
    let probeSignal!: AbortSignal;
    const result = await runConnectorProbePump(
      (signal) => untilAborted(signal),
      async (signal) => {
        probeSignal = signal;
        return {
          json: async () => {
            if (signal.aborted) {
              throw new DOMException("This operation was aborted", "AbortError");
            }
            return { connected: true };
          },
        };
      },
      async (response) => response.json(),
    );

    expect(probeSignal.aborted).toBe(true);
    expect(result).toEqual({ connected: true });
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

    const failure = await runConnectorProbePump(
      runOnce,
      async () => { throw new Error("probe failed"); },
      async (value) => value,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("probe failed");
    // The probe reached a verdict, so the provider is the subject of it.
    expect(probeFailureSource(failure)).toBe("provider");
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

    const failure = await runConnectorProbePump(
      async () => { throw new Error("poll failed"); },
      runProbe,
      async (value) => value,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConnectorPollingFailedError);
    expect((failure as ConnectorPollingFailedError).cause).toBeInstanceOf(Error);
    expect(probeFinished).toBe(true);
  });

  it("blames the connector, not the provider, when the long poll is what aborted", async () => {
    // The failure that reached production: an abort raised on the polling side
    // was reported verbatim as "PROVIDER UNAVAILABLE: This operation was
    // aborted", naming a CLI that had never been asked for a verdict and
    // costing a day of debugging the wrong component.
    const failure = await runConnectorProbePump(
      async () => { throw new DOMException("This operation was aborted", "AbortError"); },
      (signal) => untilAborted(signal),
      async (value) => value,
    ).catch((error: unknown) => error);

    expect(probeFailureSource(failure)).toBe("connector");
    const reason = probeFailureReason(failure);
    expect(reason).toContain("polling stopped");
    expect(reason).toContain("AbortError");
  });
});
