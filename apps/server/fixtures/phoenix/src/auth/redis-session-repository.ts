import type { Session } from "../models/session";
import {
  SESSION_TTL_SECONDS,
  sessionKey,
  type CreateSessionInput,
  type SessionRepository,
} from "./session-repository";

/** The subset of a Redis client this repository needs. No real client here. */
export interface RedisClient {
  set(key: string, value: string, options: { ttlSeconds: number }): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export class RedisSessionRepository implements SessionRepository {
  constructor(
    private readonly redis: RedisClient,
    private readonly newId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: CreateSessionInput): Promise<Session> {
    const issuedAt = this.now();
    const session: Session = {
      id: this.newId(),
      userId: input.userId,
      createdAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
    };
    if (input.deviceId !== undefined) {
      session.deviceId = input.deviceId;
    }
    // The store TTL and the expiresAt field come from the same constant, so
    // they cannot drift.
    await this.redis.set(sessionKey(session.id), JSON.stringify(session), {
      ttlSeconds: SESSION_TTL_SECONDS,
    });
    return session;
  }

  async find(sessionId: string): Promise<Session | null> {
    const raw = await this.redis.get(sessionKey(sessionId));
    return raw === null ? null : (JSON.parse(raw) as Session);
  }

  async revoke(sessionId: string): Promise<void> {
    await this.redis.del(sessionKey(sessionId));
  }
}
