import { z } from "zod";
import { isGitHubRepositoryId } from "../authorization/github-repository-id.js";
import { HttpError } from "../errors.js";
import type { ProjectRepository } from "./repository.js";
import type { ProjectListPage } from "./types.js";

const cursorPayload = z.strictObject({
  version: z.literal(1),
  afterGitHubRepositoryId: z.string().refine(isGitHubRepositoryId),
});
const cursorPattern = /^[A-Za-z0-9_-]{1,256}$/;

export class ProjectService {
  constructor(private readonly repository: ProjectRepository) {}

  async listProjects(input: Readonly<{
    authenticatedUserId: string;
    limit: number;
    cursor?: string | undefined;
  }>): Promise<ProjectListPage> {
    const userId = z.string().uuid().parse(input.authenticatedUserId);
    const limit = z.number().int().min(1).max(50).parse(input.limit);
    const afterGitHubRepositoryId = decodeCursor(input.cursor);
    const rows = await this.repository.listForUser({
      authenticatedUserId: userId,
      afterGitHubRepositoryId,
      limit: limit + 1,
    });
    if (rows.length > limit + 1) {
      throw new HttpError(503, "Project discovery is temporarily unavailable");
    }
    const projects = rows.slice(0, limit);
    const last = projects.at(-1);
    return {
      projects,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.githubRepositoryId)
          : null,
    };
  }
}

function decodeCursor(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!cursorPattern.test(value)) throw invalidCursor();
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value || bytes.byteLength > 192) {
      throw invalidCursor();
    }
    const parsed = cursorPayload.parse(JSON.parse(bytes.toString("utf8")));
    return parsed.afterGitHubRepositoryId;
  } catch {
    throw invalidCursor();
  }
}

function encodeCursor(afterGitHubRepositoryId: string): string {
  return Buffer.from(
    JSON.stringify({ version: 1, afterGitHubRepositoryId }),
    "utf8",
  ).toString("base64url");
}

function invalidCursor(): z.ZodError {
  return new z.ZodError([
    {
      code: "custom",
      path: ["cursor"],
      message: "Invalid project cursor",
    },
  ]);
}
