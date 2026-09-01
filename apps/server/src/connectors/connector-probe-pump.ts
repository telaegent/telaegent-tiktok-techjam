/**
 * Distinguishes a polling-side failure from a provider-side one.
 *
 * The pump drives two independent activities on one signal, and either can
 * fail first. Reporting both as "this provider is unavailable" told a
 * developer to go and look at a CLI that was never the problem, so the side
 * that actually failed now travels with the error.
 */
export class ConnectorPollingFailedError extends Error {
  constructor(public readonly cause: unknown) {
    super("Connector polling failed before the live probe completed");
    this.name = "ConnectorPollingFailedError";
  }
}

/**
 * Runs connector polls until the cloud-side live probe settles.
 *
 * A single poll is insufficient: cancellations and resource requests are
 * valid, higher-priority deliveries and may arrive before the probe job. The
 * shared signal also guarantees that either side failing stops and joins the
 * other side before the caller tries another provider.
 *
 * Teardown is deliberately not an outcome. Aborting the shared signal is how
 * this function stops the side that did not settle, so an abort observed after
 * the race has already been decided says nothing about either side's health.
 * It used to be able to win the race and be reported as the provider's verdict.
 */
export async function runConnectorProbePump<T>(
  runOnce: (signal: AbortSignal) => Promise<unknown>,
  runProbe: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const { signal } = controller;

  const polling = (async () => {
    while (!signal.aborted) {
      await runOnce(signal);
    }
  })();
  const probe = runProbe(signal);

  try {
    return await Promise.race([
      probe,
      // A rejection here is the poller's, not the provider's. Both the normal
      // stop and the failure are relabelled so neither can be mistaken for a
      // verdict on the CLI the caller is about to name.
      polling.then(
        () => {
          throw new Error("Connector polling stopped before the live probe completed");
        },
        (error: unknown) => {
          throw new ConnectorPollingFailedError(error);
        },
      ),
    ]);
  } finally {
    controller.abort();
    // Never leave a rejected request or long poll detached from the provider
    // loop. allSettled is deliberate: the error selected by Promise.race is
    // the one the caller should classify.
    await Promise.allSettled([polling, probe]);
  }
}
