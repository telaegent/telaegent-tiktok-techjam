/**
 * Runs connector polls until the cloud-side live probe settles.
 *
 * A single poll is insufficient: cancellations and resource requests are
 * valid, higher-priority deliveries and may arrive before the probe job. The
 * shared signal also guarantees that either side failing stops and joins the
 * other side before the caller tries another provider.
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
      polling.then(() => {
        throw new Error("Connector polling stopped before the live probe completed");
      }),
    ]);
  } finally {
    controller.abort();
    // Never leave a rejected request or long poll detached from the provider
    // loop. allSettled is deliberate: the error selected by Promise.race is
    // the one the caller should classify.
    await Promise.allSettled([polling, probe]);
  }
}
