import type { SessionService } from "../auth/session";
import type { GoogleOAuthProvider } from "../auth/oauth";
import { toUser } from "../auth/oauth";
import type { User } from "../models/user";

export interface CallbackResult {
  status: 200 | 401;
  sessionId?: string;
  user?: User;
  error?: string;
}

export interface CallbackRequest {
  code: string;
  /** Present when the client sent a device fingerprint header. */
  deviceId?: string;
}

/**
 * GET /oauth/callback — exchanges the code, then starts a session through
 * SessionService. It does not create sessions itself.
 */
export async function handleOAuthCallback(
  request: CallbackRequest,
  provider: GoogleOAuthProvider,
  sessions: SessionService,
  now: () => Date = () => new Date(),
): Promise<CallbackResult> {
  let profile;
  try {
    profile = await provider.exchangeCode(request.code);
  } catch {
    return { status: 401, error: "invalid_grant" };
  }
  const user = toUser(profile, now().toISOString());
  const session = await sessions.startSession(user.id, request.deviceId);
  return { status: 200, sessionId: session.id, user };
}
