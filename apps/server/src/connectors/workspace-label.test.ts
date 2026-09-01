import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectRelativeDisplayLabel } from "./workspace-label.js";

const workspace = path.resolve("/repo");

describe("projectRelativeDisplayLabel", () => {
  it("returns a forward-slash relative label for a contained path", () => {
    expect(
      projectRelativeDisplayLabel(workspace, path.join(workspace, "src", "auth", "session.ts")),
    ).toBe("src/auth/session.ts");
  });

  it("returns null for a sibling directory that shares a prefix", () => {
    expect(
      projectRelativeDisplayLabel(workspace, path.resolve("/repo-secrets/keys.env")),
    ).toBeNull();
  });

  it("returns null for a parent traversal", () => {
    expect(
      projectRelativeDisplayLabel(workspace, path.join(workspace, "..", "other", "a.ts")),
    ).toBeNull();
  });

  it("returns null for the workspace root itself", () => {
    expect(projectRelativeDisplayLabel(workspace, workspace)).toBeNull();
  });

  it("returns null for a home-directory path outside the workspace", () => {
    expect(
      projectRelativeDisplayLabel(workspace, path.resolve("/home/dev/.aws/credentials")),
    ).toBeNull();
  });
});
