import type { User } from "../models/user";

export interface OAuthProfile {
  subject: string;
  email: string;
  displayName: string;
}

/** Fake provider interface. No network, no client secret, no browser redirect. */
export interface GoogleOAuthProvider {
  buildAuthorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<OAuthProfile>;
}

export class StubGoogleOAuthProvider implements GoogleOAuthProvider {
  constructor(private readonly profiles: Record<string, OAuthProfile> = {}) {}

  buildAuthorizationUrl(state: string): string {
    return "https://accounts.example.test/authorize?state=" + encodeURIComponent(state);
  }

  async exchangeCode(code: string): Promise<OAuthProfile> {
    const profile = this.profiles[code];
    if (profile === undefined) {
      throw new Error("Unknown authorization code");
    }
    return profile;
  }
}

export function toUser(profile: OAuthProfile, createdAt: string): User {
  return {
    id: "user_" + profile.subject,
    email: profile.email,
    displayName: profile.displayName,
    createdAt,
  };
}
