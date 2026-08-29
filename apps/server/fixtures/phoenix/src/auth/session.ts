import type { Session } from "../models/session";
import { isExpired } from "../models/session";
import type { SessionRepository } from "./session-repository";

/**
 * Application-level session service. Everything above this layer — routes,
 * middleware, OAuth — goes through here rather than through a repository.
 */
export class SessionService {
  constructor(
    private readonly repository: SessionRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async startSession(userId: string, deviceId?: string): Promise<Session> {
    return this.repository.create(
      deviceId === undefined ? { userId } : { userId, deviceId },
    );
  }

  async resolve(sessionId: string): Promise<Session | null> {
    const session = await this.repository.find(sessionId);
    if (session === null) return null;
    if (isExpired(session, this.now())) {
      await this.repository.revoke(sessionId);
      return null;
    }
    return session;
  }

  /** Idempotent by contract: signing out twice is not an error. */
  async endSession(sessionId: string): Promise<void> {
    await this.repository.revoke(sessionId);
  }
}
