import type { Session } from "../models/session";
import {
  SESSION_TTL_SECONDS,
  type CreateSessionInput,
  type SessionRepository,
} from "./session-repository";

/** Deterministic in-memory store. Every test uses this; nothing hits a network. */
export class FakeSessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, Session>();
  private counter = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(input: CreateSessionInput): Promise<Session> {
    this.counter += 1;
    const issuedAt = this.now();
    const session: Session = {
      id: "sess_" + this.counter,
      userId: input.userId,
      createdAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
    };
    if (input.deviceId !== undefined) {
      session.deviceId = input.deviceId;
    }
    this.sessions.set(session.id, session);
    return session;
  }

  async find(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async revoke(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }
}
