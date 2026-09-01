import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { UserAuthenticationError } from "../authentication/types.js";

const userIdSchema = z.string().uuid();
const connectorInstanceIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const pairingCodePattern = /^[A-Za-z0-9_-]{43}$/;

type PendingPairing = {
  authenticatedUserId: string;
  connectorInstanceId: string;
  expiresAtMs: number;
};

export type ConnectorPairing = {
  pairingCode: string;
  connectorInstanceId: string;
  expiresAt: string;
};

/**
 * Process-local, single-use connector bootstrap codes.
 *
 * The normal connector bearer is deliberately absent from browser-visible
 * commands. A high-entropy, short-lived code crosses through argv once and is
 * atomically consumed for the durable credential. The control plane already
 * has a process-local relay for the hackathon deployment, so keeping this
 * ephemeral bootstrap state beside it avoids introducing durable secret
 * material into Supabase.
 */
export class ConnectorPairingService {
  private readonly pending = new Map<string, PendingPairing>();
  private readonly pendingByUser = new Map<string, string>();
  private readonly liveBindings = new Set<string>();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly maximumPending = 10_000,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 15 * 60_000) {
      throw new Error("Connector pairing TTL is invalid");
    }
    if (!Number.isInteger(maximumPending) || maximumPending < 1) {
      throw new Error("Connector pairing capacity is invalid");
    }
  }

  issue(authenticatedUserId: string): ConnectorPairing {
    const userId = userIdSchema.parse(authenticatedUserId);
    this.prune();
    const previousKey = this.pendingByUser.get(userId);
    if (previousKey) this.deletePending(previousKey);
    if (this.pending.size >= this.maximumPending) {
      throw new UserAuthenticationError(
        "AUTHENTICATION_UNAVAILABLE",
        "Connector pairing is temporarily unavailable",
        503,
      );
    }
    const pairingCode = randomBytes(32).toString("base64url");
    const connectorInstanceId = `connector_${randomUUID().replaceAll("-", "")}`;
    const expiresAtMs = this.now().getTime() + this.ttlMs;
    const key = hash(pairingCode);
    this.pending.set(key, {
      authenticatedUserId: userId,
      connectorInstanceId,
      expiresAtMs,
    });
    this.pendingByUser.set(userId, key);
    return {
      pairingCode,
      connectorInstanceId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  consume(rawPairingCode: unknown): {
    authenticatedUserId: string;
    connectorInstanceId: string;
  } {
    if (
      typeof rawPairingCode !== "string" ||
      !pairingCodePattern.test(rawPairingCode)
    ) {
      throw pairingRejected();
    }
    const key = hash(rawPairingCode);
    const pairing = this.pending.get(key);
    // Delete before any caller performs asynchronous credential issuance. This
    // makes two concurrent exchanges deterministic: exactly one can win.
    this.deletePending(key);
    if (!pairing || pairing.expiresAtMs <= this.now().getTime()) {
      throw pairingRejected();
    }
    return {
      authenticatedUserId: pairing.authenticatedUserId,
      connectorInstanceId: pairing.connectorInstanceId,
    };
  }

  markLive(
    authenticatedUserId: string,
    connectorInstanceId: string,
    connectorBindingId: string,
  ): void {
    const userId = userIdSchema.parse(authenticatedUserId);
    const instanceId = connectorInstanceIdSchema.parse(connectorInstanceId);
    const bindingId = z.string().uuid().parse(connectorBindingId);
    const key = liveKey(userId, instanceId, bindingId);
    this.liveBindings.delete(key);
    this.liveBindings.add(key);
    while (this.liveBindings.size > this.maximumPending) {
      const oldest = this.liveBindings.values().next().value as string | undefined;
      if (!oldest) break;
      this.liveBindings.delete(oldest);
    }
  }

  isLive(authenticatedUserId: string, connectorInstanceId: string): boolean {
    const prefix = `${userIdSchema.parse(authenticatedUserId)}:${connectorInstanceIdSchema.parse(connectorInstanceId)}:`;
    for (const key of this.liveBindings) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  clearLive(authenticatedUserId: string, connectorInstanceId: string): void {
    const prefix = `${userIdSchema.parse(authenticatedUserId)}:${connectorInstanceIdSchema.parse(connectorInstanceId)}:`;
    for (const key of this.liveBindings) {
      if (key.startsWith(prefix)) this.liveBindings.delete(key);
    }
  }

  private prune(): void {
    const nowMs = this.now().getTime();
    for (const [key, pairing] of this.pending) {
      if (pairing.expiresAtMs <= nowMs) this.deletePending(key);
    }
  }

  private deletePending(key: string): void {
    const pairing = this.pending.get(key);
    this.pending.delete(key);
    if (pairing && this.pendingByUser.get(pairing.authenticatedUserId) === key) {
      this.pendingByUser.delete(pairing.authenticatedUserId);
    }
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function liveKey(userId: string, connectorInstanceId: string, bindingId: string): string {
  return `${userId}:${connectorInstanceId}:${bindingId}`;
}

function pairingRejected(): UserAuthenticationError {
  return new UserAuthenticationError(
    "AUTHENTICATION_FAILED",
    "Connector pairing code is invalid, expired, or already used",
  );
}
