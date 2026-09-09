/**
 * Plan section 7.1. Protocol version and capability negotiation, kept in one
 * tiny module so the connector binary and the cloud agree without the CLI
 * pulling in relay internals.
 *
 * A connector that advertises nothing negotiates version 1 and remains fully
 * usable for every job that existed before the clarification loop. Capability
 * absence is not provider unavailability: the caller falls back to human
 * clarification instead of reporting a broken runtime.
 */
export const CONNECTOR_PROTOCOL_VERSION = 2;

export const CONNECTOR_CAPABILITIES = [
  "task_sessions_v1",
  "peer_clarification_v1",
] as const;

export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export interface ConnectorAdvertisement {
  protocolVersion?: number | undefined;
  capabilities?: readonly ConnectorCapability[] | undefined;
}
