import { z } from "zod";
import { SupabaseRpcTransport } from "../supabase-rpc-transport.js";
import type {
  ConnectorDeviceAuthorizationRepository,
  DeviceAuthorizationDecision,
  DeviceAuthorizationView,
} from "./connector-device-authorization.js";

const viewSchema = z.strictObject({
  connectorInstanceId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
  status: z.enum(["pending", "approved", "denied", "expired", "consumed"]),
  expiresAt: z.string().datetime({ offset: true }),
});
const claimSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.enum(["pending", "slow_down", "denied", "expired", "consumed"]) }),
  z.strictObject({
    outcome: z.literal("approved"),
    authenticatedUserId: z.string().uuid(),
    connectorInstanceId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
  }),
]);

export class SupabaseConnectorDeviceAuthorizationRepository
  implements ConnectorDeviceAuthorizationRepository
{
  private readonly transport: SupabaseRpcTransport;

  constructor(
    supabaseUrl: string,
    secretKey: string,
    private readonly timeoutMs: number,
    fetchImplementation?: typeof fetch,
  ) {
    this.transport = new SupabaseRpcTransport({
      supabaseUrl,
      secretKey,
      maximumResponseBytes: 16_384,
      ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
    });
  }

  async create(record: Readonly<{
    deviceCodeHash: string;
    userCodeHash: string;
    connectorInstanceId: string;
    status: DeviceAuthorizationView["status"];
    authenticatedUserId: string | null;
    createdAt: string;
    expiresAt: string;
    intervalSeconds: number;
    lastPolledAt: string | null;
  }>): Promise<boolean> {
    return z.boolean().parse(await this.call("create_connector_device_authorization", {
      p_device_code_hash_hex: record.deviceCodeHash,
      p_user_code_hash_hex: record.userCodeHash,
      p_connector_instance_id: record.connectorInstanceId,
      p_created_at: record.createdAt,
      p_expires_at: record.expiresAt,
      p_interval_seconds: record.intervalSeconds,
    }));
  }

  async loadByUserCodeHash(userCodeHash: string, now: string): Promise<DeviceAuthorizationView | null> {
    const value = await this.call("load_connector_device_authorization", {
      p_user_code_hash_hex: userCodeHash,
      p_now: now,
    });
    return value === null ? null : viewSchema.parse(value);
  }

  async decide(input: Readonly<{
    userCodeHash: string;
    authenticatedUserId: string;
    decision: DeviceAuthorizationDecision;
    now: string;
  }>): Promise<DeviceAuthorizationView | null> {
    const value = await this.call("decide_connector_device_authorization", {
      p_user_code_hash_hex: input.userCodeHash,
      p_user_id: input.authenticatedUserId,
      p_decision: input.decision,
      p_now: input.now,
    });
    return value === null ? null : viewSchema.parse(value);
  }

  async claim(input: Readonly<{ deviceCodeHash: string; now: string }>) {
    return claimSchema.parse(await this.call("claim_connector_device_authorization", {
      p_device_code_hash_hex: input.deviceCodeHash,
      p_now: input.now,
    }));
  }

  private async call(name: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      return await this.transport.call(name, body, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
