/**
 * Distinguishes a polling-side failure from a provider-side one.
 *
 * The pump drives two independent activities, and either can
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
 * separate cancellation signals guarantee that either side failing stops and
 * joins the other side before the caller tries another provider. They must be
 * separate because fetch resolves when response headers arrive; aborting that
 * fetch signal before the caller consumes the body turns a successful probe
 * into an AbortError during response.json().
 *
 * Teardown is deliberately not an outcome. The probe is fully materialized
 * before either signal is cleaned up, and only then may its value cross back
 * to the caller.
 */
export async function runConnectorProbePump<TWire, TResult>(
  runOnce: (signal: AbortSignal) => Promise<unknown>,
  runProbe: (signal: AbortSignal) => Promise<TWire>,
  materializeProbe: (wire: TWire) => Promise<TResult>,
): Promise<TResult> {
  const pollingController = new AbortController();
  const probeController = new AbortController();
  const pollingSignal = pollingController.signal;
  const probeSignal = probeController.signal;

  const polling = (async () => {
    while (!pollingSignal.aborted) {
      await runOnce(pollingSignal);
    }
  })();
  // A fetch promise settles when response headers arrive, not when its body is
  // consumed. Materialization is therefore part of the probe lifetime: no
  // signal-bound Response may escape across cancellation cleanup.
  const probe = (async () => materializeProbe(await runProbe(probeSignal)))();
  const outcome = await Promise.race([
    probe.then(
      (value) => ({ source: "probe", ok: true, value }) as const,
      (error: unknown) => ({ source: "probe", ok: false, error }) as const,
    ),
    polling.then(
      () => ({
        source: "polling",
        error: new ConnectorPollingFailedError(
          new Error("Connector polling stopped before the live probe completed"),
        ),
      }) as const,
      (error: unknown) => ({
        source: "polling",
        error: new ConnectorPollingFailedError(error),
      }) as const,
    ),
  ]);

  if (outcome.source === "probe") {
    pollingController.abort();
    await Promise.allSettled([polling]);
    // The probe and its response body are fully settled at this point.
    probeController.abort();
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  }

  probeController.abort();
  await Promise.allSettled([polling, probe]);
  throw outcome.error;
}
