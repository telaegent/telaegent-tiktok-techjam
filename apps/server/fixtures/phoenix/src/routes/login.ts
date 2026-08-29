import type { GoogleOAuthProvider } from "../auth/oauth";

export interface LoginResponse {
  status: 302;
  location: string;
}

/** POST /login — starts the OAuth handshake. Owns no session state. */
export function handleLogin(
  provider: GoogleOAuthProvider,
  state: string,
): LoginResponse {
  return { status: 302, location: provider.buildAuthorizationUrl(state) };
}
