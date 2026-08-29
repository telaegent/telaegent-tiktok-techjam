export interface Session {
  id: string;
  userId: string;
  /**
   * Device the session was created from.
   *
   * Optional today so existing clients keep working. See
   * docs/architecture/auth.md — "Device binding".
   */
  deviceId?: string;
  createdAt: string;
  expiresAt: string;
}

export function isExpired(session: Session, now: Date): boolean {
  return new Date(session.expiresAt).getTime() <= now.getTime();
}
