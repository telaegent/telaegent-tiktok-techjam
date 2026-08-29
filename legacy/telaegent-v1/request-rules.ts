import { createHash } from "node:crypto";
import { TELAEGENT_LIMITS } from "./constants.js";
import type {
  IdempotencyRecord,
  TelaegentRequest,
  TelaegentToolName,
} from "./types.js";

export class RequestRuleError extends Error {
  constructor(
    public readonly code:
      | "INVALID_REQUEST"
      | "EXPIRED"
      | "EXCHANGE_LIMIT"
      | "INVALID_STATE",
    message: string,
  ) {
    super(message);
    this.name = "RequestRuleError";
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RequestRuleError("INVALID_REQUEST", "Non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new RequestRuleError("INVALID_REQUEST", "Unsupported value in canonical request");
}

function executionFingerprintInput(request: TelaegentRequest): unknown {
  return {
    schemaVersion: request.schemaVersion,
    projectId: request.projectId,
    conversationId: request.conversationId,
    intentId: request.intentId ?? null,
    sender: request.sender,
    recipient: request.recipient ?? null,
    operation: request.operation,
    payload: request.payload,
    delivery: {
      mode: request.delivery.mode,
      exchangeNumber: request.delivery.exchangeNumber,
      expiresAt: request.delivery.expiresAt,
      replyToRequestId: request.delivery.replyToRequestId ?? null,
    },
    evidence: request.evidence,
  };
}

export function fingerprintRequest(request: TelaegentRequest): string {
  return createHash("sha256")
    .update(canonicalize(executionFingerprintInput(request)))
    .digest("hex");
}

export function idempotencyScope(request: TelaegentRequest): string {
  return [
    request.projectId,
    request.sender.agentId,
    request.operation,
    request.idempotencyKey,
  ].join(":");
}

export type IdempotencyEvaluation =
  | { kind: "create"; fingerprint: string }
  | { kind: "replay"; operationId: string; requestId: string }
  | {
      kind: "conflict";
      code: "IDEMPOTENCY_KEY_REUSED";
      operationId: string;
      requestId: string;
    };

function recordScope(record: IdempotencyRecord): string {
  return [record.projectId, record.senderAgentId, record.operation, record.idempotencyKey].join(":");
}

export function evaluateIdempotency(
  records: readonly IdempotencyRecord[],
  request: TelaegentRequest,
  now: string,
): IdempotencyEvaluation {
  const scope = idempotencyScope(request);
  const existing = records.find(
    (record) => recordScope(record) === scope && Date.parse(record.expiresAt) > Date.parse(now),
  );
  const fingerprint = fingerprintRequest(request);
  if (!existing) return { kind: "create", fingerprint };
  if (existing.requestFingerprint === fingerprint) {
    return { kind: "replay", operationId: existing.operationId, requestId: existing.requestId };
  }
  return {
    kind: "conflict",
    code: "IDEMPOTENCY_KEY_REUSED",
    operationId: existing.operationId,
    requestId: existing.requestId,
  };
}

export function createIdempotencyRecord(
  request: TelaegentRequest,
  operationId: string,
  createdAt: string,
): IdempotencyRecord {
  return {
    projectId: request.projectId,
    senderAgentId: request.sender.agentId,
    operation: request.operation,
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: fingerprintRequest(request),
    requestId: request.requestId,
    operationId,
    expiresAt: new Date(
      Math.max(Date.parse(request.delivery.expiresAt), Date.parse(createdAt)) +
        TELAEGENT_LIMITS.idempotencyRetentionMs,
    ).toISOString(),
    createdAt,
  };
}

export function assertRequestTiming(request: TelaegentRequest, now: string): void {
  const createdAt = Date.parse(request.delivery.createdAt);
  const expiresAt = Date.parse(request.delivery.expiresAt);
  const currentTime = Date.parse(now);
  if (createdAt > currentTime + TELAEGENT_LIMITS.maxClockSkewMs) {
    throw new RequestRuleError("INVALID_REQUEST", "Request creation time is too far in the future");
  }
  if (expiresAt <= currentTime) {
    throw new RequestRuleError("EXPIRED", "The request has expired");
  }
  if (expiresAt - createdAt > TELAEGENT_LIMITS.maxRequestTtlMs) {
    throw new RequestRuleError("INVALID_REQUEST", "Request TTL exceeds the maximum");
  }
}

type ReplyRequest = Extract<TelaegentRequest, { operation: "relay_reply" }>;

export function assertReplyInheritance(
  reply: ReplyRequest,
  original: TelaegentRequest,
): void {
  if (!original.recipient) {
    throw new RequestRuleError("INVALID_STATE", "The original request has no reply recipient");
  }
  if (original.delivery.exchangeNumber >= TELAEGENT_LIMITS.maxExchangeNumber) {
    throw new RequestRuleError("EXCHANGE_LIMIT", "The coordination exchange limit was reached");
  }
  const identityMatches =
    reply.sender.ownerId === original.recipient.ownerId &&
    reply.sender.agentId === original.recipient.agentId &&
    reply.recipient?.ownerId === original.sender.ownerId &&
    reply.recipient.agentId === original.sender.agentId;
  const scopeMatches =
    reply.projectId === original.projectId &&
    reply.conversationId === original.conversationId &&
    reply.intentId === original.intentId &&
    reply.schemaVersion === original.schemaVersion &&
    reply.delivery.expiresAt === original.delivery.expiresAt;
  const orderingMatches =
    reply.delivery.exchangeNumber === original.delivery.exchangeNumber + 1 &&
    reply.payload.replyToRequestId === original.requestId &&
    reply.delivery.replyToRequestId === original.requestId;
  if (!identityMatches || !scopeMatches || !orderingMatches) {
    throw new RequestRuleError(
      "INVALID_REQUEST",
      "Reply does not inherit the original request identity, scope, expiry, and ordering",
    );
  }
}

export function idempotencyRecordKey(
  projectId: string,
  senderAgentId: string,
  operation: TelaegentToolName,
  idempotencyKey: string,
): string {
  return [projectId, senderAgentId, operation, idempotencyKey].join(":");
}
