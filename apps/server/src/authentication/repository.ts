import type { TelaegentWebUser } from "./types.js";

export interface CompleteGitHubLoginInput {
  githubUserId: string;
  githubLogin: string;
  avatarUrl: string | null;
  sessionTokenHashHex: string;
  sessionTtlSeconds: number;
}

export interface TelaegentIdentityRepository {
  createOAuthState(input: {
    stateHashHex: string;
    returnTo: string;
  }): Promise<void>;
  consumeOAuthState(stateHashHex: string): Promise<string | null>;
  completeGitHubLogin(input: CompleteGitHubLoginInput): Promise<TelaegentWebUser | null>;
  loadWebSession(sessionTokenHashHex: string): Promise<TelaegentWebUser | null>;
  revokeWebSession(sessionTokenHashHex: string): Promise<boolean>;
}
