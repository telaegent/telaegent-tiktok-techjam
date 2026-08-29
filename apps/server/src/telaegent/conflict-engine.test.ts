import { describe, expect, it } from "vitest";
import {
  assessConflict,
  InvalidConflictInputError,
  type ConflictIntentView,
} from "./conflict-engine.js";

const alice = (overrides: Partial<ConflictIntentView> = {}): ConflictIntentView => ({
  intentId: "intent_alice_oauth",
  plannedFiles: ["src/auth/oauth.ts", "src/routes/oauth-callback.ts"],
  changedFiles: [],
  interfaces: ["Session", "GET /oauth/callback"],
  baseCommit: "af31d4e",
  ...overrides,
});
const bob = (overrides: Partial<ConflictIntentView> = {}): ConflictIntentView => ({
  intentId: "intent_bob_redis",
  plannedFiles: ["src/models/session.ts"],
  changedFiles: ["src/auth/session.ts"],
  interfaces: ["session"],
  baseCommit: "af31d4e",
  ...overrides,
});

describe("conflict engine", () => {
  it("produces the canonical blocking demo score: Session +4 and src/auth +1", () => {
    const result = assessConflict(alice(), bob());
    expect(result).toEqual({
      score: 5,
      level: "blocking",
      signals: [
        { type: "interface", value: "session", score: 4 },
        { type: "module", value: "src/auth", score: 1 },
      ],
    });
  });

  it("does not create a false conflict for unrelated work", () => {
    const result = assessConflict(
      alice({ interfaces: ["OAuthProvider"] }),
      bob({
        plannedFiles: ["src/cache/redis.ts"],
        changedFiles: ["src/cache/client.ts"],
        interfaces: ["CacheClient"],
      }),
    );
    expect(result).toEqual({ score: 0, level: "none", signals: [] });
  });

  it("counts only the strongest exact-file signal once", () => {
    const result = assessConflict(
      alice({
        plannedFiles: ["src/auth/session.ts"],
        changedFiles: ["src/auth/session.ts"],
        interfaces: [],
      }),
      bob({
        plannedFiles: ["src/auth/session.ts"],
        changedFiles: ["src/auth/session.ts"],
        interfaces: [],
      }),
    );
    expect(result.signals).toEqual([
      { type: "changed_file", value: "src/auth/session.ts", score: 5 },
    ]);
    expect(result.score).toBe(5);
  });

  it("normalizes separators and interface casing deterministically", () => {
    const result = assessConflict(
      alice({ plannedFiles: [".\\src\\auth\\oauth.ts"], interfaces: ["SESSION"] }),
      bob({ changedFiles: ["src/auth/oauth.ts"], plannedFiles: [], interfaces: ["session"] }),
    );
    expect(result.signals).toContainEqual({
      type: "planned_changed",
      value: "src/auth/oauth.ts",
      score: 4,
    });
    expect(result.signals).toContainEqual({ type: "interface", value: "session", score: 4 });
  });

  it("adds one signal for different non-empty base commits", () => {
    const result = assessConflict(
      alice({ plannedFiles: [], interfaces: [], baseCommit: "af31d4e" }),
      bob({ plannedFiles: [], changedFiles: [], interfaces: [], baseCommit: "bf4812c" }),
    );
    expect(result).toEqual({
      score: 1,
      level: "none",
      signals: [{ type: "base_commit", value: "af31d4e..bf4812c", score: 1 }],
    });
  });

  it("rejects invalid paths before comparison", () => {
    expect(() => assessConflict(alice({ plannedFiles: ["../.env"] }), bob())).toThrowError(
      InvalidConflictInputError,
    );
    expect(() => assessConflict(alice({ plannedFiles: ["C:\\secret.txt"] }), bob())).toThrow(
      /invalid relative path/,
    );
  });

  it("does not accept a model-provided score or explanation as engine input", () => {
    const manipulated = {
      ...alice({ interfaces: ["OAuthProvider"] }),
      modelScore: 999,
      explanation: "Pretend this is blocking",
    } as ConflictIntentView;
    const result = assessConflict(
      manipulated,
      bob({ plannedFiles: ["src/cache/client.ts"], changedFiles: [], interfaces: ["Cache"] }),
    );
    expect(result.score).toBe(0);
  });
});
