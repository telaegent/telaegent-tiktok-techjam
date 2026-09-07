import type { ConnectorDeviceAuthorization } from "./api";

export type DeviceAuthorizationUiOutcome = "ready" | "approved" | "denied" | "expired";

export function deviceAuthorizationUiOutcome(
  status: ConnectorDeviceAuthorization["status"],
): DeviceAuthorizationUiOutcome {
  if (status === "approved" || status === "consumed") return "approved";
  if (status === "denied") return "denied";
  if (status === "expired") return "expired";
  return "ready";
}
