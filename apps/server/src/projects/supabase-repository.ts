import { HttpError } from "../errors.js";
import { SupabaseRpcTransport } from "../supabase-rpc-transport.js";
import type { ProjectRepository } from "./repository.js";
import { projectSummaryRowsSchema, type ProjectSummary } from "./types.js";

export class SupabaseProjectRepository implements ProjectRepository {
  private readonly transport: SupabaseRpcTransport;

  constructor(
    supabaseUrl: string,
    secretKey: string,
    private readonly timeoutMs: number,
    fetchImplementation?: typeof fetch,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
      throw new Error("Project persistence configuration is invalid");
    }
    this.transport = new SupabaseRpcTransport({
      supabaseUrl,
      secretKey,
      maximumResponseBytes: 262_144,
      ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
    });
  }

  async listForUser(input: Readonly<{
    authenticatedUserId: string;
    afterGitHubRepositoryId: string | null;
    limit: number;
  }>): Promise<ProjectSummary[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const value = await this.transport.call(
        "list_user_projects",
        {
          p_user_id: input.authenticatedUserId,
          p_after_github_repository_id: input.afterGitHubRepositoryId,
          p_limit: input.limit,
        },
        { signal: controller.signal },
      );
      const parsed = projectSummaryRowsSchema.safeParse(value);
      if (!parsed.success) throw unavailable();
      return parsed.data;
    } catch {
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
}

function unavailable(): HttpError {
  return new HttpError(503, "Project discovery is temporarily unavailable");
}
