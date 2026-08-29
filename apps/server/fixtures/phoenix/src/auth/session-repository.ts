import type { Session } from "../models/session";

export interface CreateSessionInput {
  userId: string;
  /** Optional today. A later change makes this required. */
  deviceId?: string;
}

/**
 * The one contract every session store implements. Route handlers depend on
 * this interface, never on a concrete store.
 */
export interface SessionRepository {
  create(input: CreateSessionInput): Promise<Session>;
  find(sessionId: string): Promise<Session | null>;
  revoke(sessionId: string): Promise<void>;
}

export const SESSION_TTL_SECONDS = 1800;

export function sessionKey(sessionId: string): string {
  return "phoenix:session:" + sessionId;
}
