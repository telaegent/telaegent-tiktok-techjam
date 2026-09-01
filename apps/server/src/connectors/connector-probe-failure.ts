import { RuntimeProviderError } from "../runtime-errors.js";

/** Bound that keeps an unexpected error from flooding the connector's output. */
const MAX_REASON_LENGTH = 200;

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
 */
export function probeFailureReason(error: unknown): string {
  if (error instanceof RuntimeProviderError) return error.code;
  if (!(error instanceof Error)) return "unknown error";
  const message = error.message.replace(/\s+/g, " ").trim();
  if (!message) return error.name;
  return message.length > MAX_REASON_LENGTH
    ? message.slice(0, MAX_REASON_LENGTH) + "..."
    : message;
}
