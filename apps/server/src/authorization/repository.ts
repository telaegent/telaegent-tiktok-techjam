import type {
  AuthorizePrivateRuntimeInput,
  GitHubConnection,
  GitHubRepositoryAccess,
  ProjectConversation,
  ProjectMembership,
  RepositoryProject,
  RuntimeBinding,
  UserAccount,
} from "./types.js";

/**
 * Records required to decide whether a private runtime may be used.
 *
 * Nullable records are intentional. The future authorization service, not the
 * repository adapter, decides which absence or state results in denial. The
 * service must also cross-check every repeated user/project/repository ID; a
 * database join alone is never treated as authorization.
 */
export interface PrivateRuntimeAuthorizationSnapshot {
  user: UserAccount | null;
  githubConnection: GitHubConnection | null;
  repositoryAccess: GitHubRepositoryAccess | null;
  project: RepositoryProject | null;
  membership: ProjectMembership | null;
  conversation: ProjectConversation | null;
  runtimeBinding: RuntimeBinding | null;
}

/**
 * Persistence-neutral read seam for private-runtime authorization.
 *
 * Implementations:
 * - must load one logically consistent snapshot for the supplied scope;
 * - should use one database statement or one transaction when backed by SQL;
 * - must not accept or derive a workspace path from browser input;
 * - must not return GitHub/provider credentials or secret references;
 * - must not make product permission decisions by filtering out inactive rows.
 *
 * Thai can implement this interface with Supabase/Postgres. Khoa's
 * authorization service will consume the snapshot and own the allow/deny
 * decision. Phuong's runtime layer receives only an AuthorizedPrivateRuntime
 * after that decision succeeds.
 */
export interface PrivateRuntimeAuthorizationRepository {
  loadPrivateRuntimeAuthorizationSnapshot(
    input: Readonly<AuthorizePrivateRuntimeInput>,
  ): Promise<PrivateRuntimeAuthorizationSnapshot>;
}

