import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ConnectorCredentialService } from "./connector-credentials.js";

const connectorInstanceIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const deviceCodePattern = /^[A-Za-z0-9_-]{43}$/;
const userCodePattern = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

export type DeviceAuthorizationDecision = "approve" | "deny";
export type DeviceAuthorizationView = {
  connectorInstanceId: string;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  expiresAt: string;
};

type DeviceAuthorizationRecord = {
  deviceCodeHash: string;
  userCodeHash: string;
  connectorInstanceId: string;
  status: DeviceAuthorizationView["status"];
  authenticatedUserId: string | null;
  createdAt: string;
  expiresAt: string;
  intervalSeconds: number;
  lastPolledAt: string | null;
};

export interface ConnectorDeviceAuthorizationRepository {
  create(record: Readonly<DeviceAuthorizationRecord>): Promise<boolean>;
  loadByUserCodeHash(userCodeHash: string, now: string): Promise<DeviceAuthorizationView | null>;
  decide(input: Readonly<{
    userCodeHash: string;
    authenticatedUserId: string;
    decision: DeviceAuthorizationDecision;
    now: string;
  }>): Promise<DeviceAuthorizationView | null>;
  claim(input: Readonly<{
    deviceCodeHash: string;
    now: string;
  }>): Promise<
    | { outcome: "pending" | "slow_down" | "denied" | "expired" | "consumed" }
    | { outcome: "approved"; authenticatedUserId: string; connectorInstanceId: string }
  >;
}

export class InMemoryConnectorDeviceAuthorizationRepository
  implements ConnectorDeviceAuthorizationRepository
{
  private readonly records = new Map<string, DeviceAuthorizationRecord>();

  async create(record: Readonly<DeviceAuthorizationRecord>): Promise<boolean> {
    if (
      this.records.has(record.deviceCodeHash) ||
      [...this.records.values()].some((candidate) => candidate.userCodeHash === record.userCodeHash)
    ) return false;
    this.records.set(record.deviceCodeHash, { ...record });
    return true;
  }

  async loadByUserCodeHash(
    userCodeHash: string,
    now: string,
  ): Promise<DeviceAuthorizationView | null> {
    const record = [...this.records.values()].find(
      (candidate) => candidate.userCodeHash === userCodeHash,
    );
    if (!record) return null;
    expire(record, now);
    return view(record);
  }

  async decide(input: Readonly<{
    userCodeHash: string;
    authenticatedUserId: string;
    decision: DeviceAuthorizationDecision;
    now: string;
  }>): Promise<DeviceAuthorizationView | null> {
    const record = [...this.records.values()].find(
      (candidate) => candidate.userCodeHash === input.userCodeHash,
    );
    if (!record) return null;
    expire(record, input.now);
    if (record.status === "pending") {
      record.status = input.decision === "approve" ? "approved" : "denied";
      record.authenticatedUserId = input.authenticatedUserId;
    }
    return view(record);
  }

  async claim(input: Readonly<{
    deviceCodeHash: string;
    now: string;
  }>): Promise<
    | { outcome: "pending" | "slow_down" | "denied" | "expired" | "consumed" }
    | { outcome: "approved"; authenticatedUserId: string; connectorInstanceId: string }
  > {
    const record = this.records.get(input.deviceCodeHash);
    if (!record) return { outcome: "expired" };
    expire(record, input.now);
    if (record.status === "pending") {
      const nowMs = Date.parse(input.now);
      const lastMs = record.lastPolledAt ? Date.parse(record.lastPolledAt) : 0;
      if (lastMs && nowMs - lastMs < record.intervalSeconds * 1_000) {
        return { outcome: "slow_down" };
      }
      record.lastPolledAt = input.now;
      return { outcome: "pending" };
    }
    if (record.status !== "approved" || !record.authenticatedUserId) {
      return { outcome: record.status } as {
        outcome: "denied" | "expired" | "consumed";
      };
    }
    record.status = "consumed";
    return {
      outcome: "approved",
      authenticatedUserId: record.authenticatedUserId,
      connectorInstanceId: record.connectorInstanceId,
    };
  }
}

export class ConnectorDeviceAuthorizationService {
  constructor(
    private readonly repository: ConnectorDeviceAuthorizationRepository,
    private readonly credentials: ConnectorCredentialService,
    private readonly publicOrigin: string,
    private readonly ttlMs = 5 * 60_000,
    private readonly intervalSeconds = 3,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 15 * 60_000) {
      throw new Error("Connector device authorization TTL is invalid");
    }
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 30) {
      throw new Error("Connector device authorization poll interval is invalid");
    }
  }

  async issue(rawConnectorInstanceId: unknown) {
    const connectorInstanceId = connectorInstanceIdSchema.parse(rawConnectorInstanceId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const deviceCode = randomBytes(32).toString("base64url");
      const userCode = createUserCode();
      const now = this.now();
      const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
      const created = await this.repository.create({
        deviceCodeHash: sha256Hex(deviceCode),
        userCodeHash: sha256Hex(userCode),
        connectorInstanceId,
        status: "pending",
        authenticatedUserId: null,
        createdAt: now.toISOString(),
        expiresAt,
        intervalSeconds: this.intervalSeconds,
        lastPolledAt: null,
      });
      if (!created) continue;
      const verificationUri = `${new URL(this.publicOrigin).origin}/app/connect-device`;
      return {
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
        expiresAt,
        intervalSeconds: this.intervalSeconds,
      };
    }
    throw new Error("Connector device authorization is temporarily unavailable");
  }

  inspect(rawUserCode: unknown): Promise<DeviceAuthorizationView | null> {
    const userCode = normalizeUserCode(rawUserCode);
    return this.repository.loadByUserCodeHash(sha256Hex(userCode), this.now().toISOString());
  }

  decide(
    rawUserCode: unknown,
    authenticatedUserId: string,
    decision: DeviceAuthorizationDecision,
  ): Promise<DeviceAuthorizationView | null> {
    return this.repository.decide({
      userCodeHash: sha256Hex(normalizeUserCode(rawUserCode)),
      authenticatedUserId: z.string().uuid().parse(authenticatedUserId),
      decision,
      now: this.now().toISOString(),
    });
  }

  async exchange(rawDeviceCode: unknown) {
    if (typeof rawDeviceCode !== "string" || !deviceCodePattern.test(rawDeviceCode)) {
      return { outcome: "expired" as const };
    }
    const result = await this.repository.claim({
      deviceCodeHash: sha256Hex(rawDeviceCode),
      now: this.now().toISOString(),
    });
    if (result.outcome !== "approved") return result;
    return {
      outcome: "approved" as const,
      connector: await this.credentials.issue(
        result.authenticatedUserId,
        result.connectorInstanceId,
      ),
    };
  }
}

function normalizeUserCode(value: unknown): string {
  if (typeof value !== "string") throw new Error("Device authorization code is invalid");
  const normalized = value.trim().toUpperCase();
  if (!userCodePattern.test(normalized)) {
    throw new Error("Device authorization code is invalid");
  }
  return normalized;
}

function createUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const characters = [...bytes].map((byte) => alphabet[byte % alphabet.length]!);
  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expire(record: DeviceAuthorizationRecord, now: string): void {
  if (
    (record.status === "pending" || record.status === "approved") &&
    Date.parse(record.expiresAt) <= Date.parse(now)
  ) {
    record.status = "expired";
  }
}

function view(record: DeviceAuthorizationRecord): DeviceAuthorizationView {
  return {
    connectorInstanceId: record.connectorInstanceId,
    status: record.status,
    expiresAt: record.expiresAt,
  };
}
