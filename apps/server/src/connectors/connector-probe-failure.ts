import { RuntimeProviderError } from "../runtime-errors.js";
import { ConnectorPollingFailedError } from "./connector-probe-pump.js";

/** Bound that keeps an unexpected error from flooding the connector's output. */
const MAX_REASON_LENGTH = 200;

/**
 * Which half of the probe pump produced the failure the developer is reading.
 *
 * "provider" means the local CLI under test reached a verdict. "connector"
 * means the long poll that carries jobs to that CLI stopped first, so the
 * provider never got its answer and nothing has been learned about it.
 */
export type ProbeFailureSource = "provider" | "connector";

export function probeFailureSource(error: unknown): ProbeFailureSource {
  return error instanceof ConnectorPollingFailedError ? "connector" : "provider";
}

/**
 * Renders one bounded, connector-safe reason for a failed provider probe.
 *
 * A probe fails for four unrelated causes: polling stopped before the probe
 * settled, the cloud call returned an error status, the response failed
 * validation, or the local turn failed. Collapsing them into a bare provider
 * name leaves a developer nothing to act on.
 *
 * Provider errors contribute their public taxonomy code rather than their
 * message, because only the code is guaranteed free of provider output. Every
 * other error reaching the probe loop is already sanitized at its source:
 * ConnectorHttpResponseError keeps only a status and a machine code, and the
 * remaining causes throw fixed strings.
 *
 * An abort carries no detail of its own -- every abort in Node reads "This
 * operation was aborted" whoever raised it -- so the name is kept alongside
 * the cause that the pump recorded rather than printed on its own, which named
 * no side and sent developers to inspect a CLI that had never run.
 */
export function probeFailureReason(error: unknown): string {
  if (error instanceof ConnectorPollingFailedError) {
    return "polling stopped: " + probeFailureReason(error.cause);
  }
  if (error instanceof RuntimeProviderError) return error.code;
  if (!(error instanceof Error)) return "unknown error";
  const message = error.message.replace(/\s+/g, " ").trim();
  if (!message) return error.name;
  const detail = message.length > MAX_REASON_LENGTH
    ? message.slice(0, MAX_REASON_LENGTH) + "..."
    : message;
  return error.name === "AbortError" ? `${detail} (${error.name})` : detail;
}
