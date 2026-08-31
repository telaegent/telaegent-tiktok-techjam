import type { ProjectSummary } from "./types.js";

export interface ProjectRepository {
  listForUser(input: Readonly<{
    authenticatedUserId: string;
    afterGitHubRepositoryId: string | null;
    limit: number;
  }>): Promise<ProjectSummary[]>;
}
