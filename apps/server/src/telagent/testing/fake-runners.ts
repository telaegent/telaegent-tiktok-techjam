/**
 * DETERMINISTIC FAKE PROVIDERS — shared by workstream #6's tests and by Khoa's
 * service and route tests (finding C12: this file is owned here so it is not
 * written twice).
 *
 * Scripted by `(purpose, stage)`, never by matching a substring of the runtime
 * prompt. A prompt-substring script silently stops matching the moment someone
 * rewords a prompt, and then the failure looks like a policy bug.
 *
 * Every script also records the exact MiddlewareRunRequest it received, so a
 * test can assert sandbox mode, session mode and network mode reached the
 * runner — the properties that actually enforce isolation.
 */

import type {
  MiddlewareRunRequest,
  NormalizedRunResult,
  RunPurpose,
} from "../contract.js";

export interface ScriptedTurn {
  purpose: RunPurpose;
  /** Which call to this purpose this entry answers, 1-based. */
  stage?: number;
  final: unknown;
  changedFiles?: string[];
  sessionId?: string;
}

export interface FakeRunner {
  runMiddlewareTurn(request: MiddlewareRunRequest): Promise<NormalizedRunResult<unknown>>;
  /** Every request received, in order. */
  calls: MiddlewareRunRequest[];
  callsFor(purpose: RunPurpose): MiddlewareRunRequest[];
  remainingScript(): ScriptedTurn[];
}

export function createFakeRunner(script: readonly ScriptedTurn[]): FakeRunner {
  const calls: MiddlewareRunRequest[] = [];
  const used = new Set<number>();
  const counts = new Map<RunPurpose, number>();

  return {
    calls,
    callsFor(purpose) {
      return calls.filter((call) => call.purpose === purpose);
    },
    remainingScript() {
      return script.filter((_, index) => !used.has(index));
    },
    async runMiddlewareTurn(request) {
      calls.push(request);
      const stage = (counts.get(request.purpose) ?? 0) + 1;
      counts.set(request.purpose, stage);

      let index = script.findIndex(
        (turn, position) =>
          !used.has(position) && turn.purpose === request.purpose && turn.stage === stage,
      );
      if (index === -1) {
        index = script.findIndex(
          (turn, position) =>
            !used.has(position) &&
            turn.purpose === request.purpose &&
            turn.stage === undefined,
        );
      }
      if (index === -1) {
        throw new Error(
          "fake runner has no script for purpose=" + request.purpose + " stage=" + stage,
        );
      }
      used.add(index);
      const turn = script[index];
      /* c8 ignore next */
      if (!turn) throw new Error("unreachable");

      return {
        provider: request.provider,
        // A fresh or ephemeral run must never hand back a session to persist.
        ...(request.sessionMode === "continue" && turn.sessionId !== undefined
          ? { sessionId: turn.sessionId }
          : {}),
        final: turn.final,
        changedFiles: turn.changedFiles ?? [],
        exitCode: 0,
        durationMs: 12,
      };
    },
  };
}

/** A runner that always fails, for testing safe error propagation. */
export function createFailingRunner(message = "provider unavailable"): FakeRunner {
  const calls: MiddlewareRunRequest[] = [];
  return {
    calls,
    callsFor: (purpose) => calls.filter((call) => call.purpose === purpose),
    remainingScript: () => [],
    async runMiddlewareTurn(request) {
      calls.push(request);
      throw new Error(message);
    },
  };
}

/* ========================================================================== *
 * Canonical demo payloads — the exact objects from TELAGENT_PRODUCT_FLOW
 * ========================================================================== */

export const BOB_INTENT_RESULT = {
  publicSummary: "I will move session storage to Redis behind SessionRepository.",
  taskState: "working" as const,
  nextAction: {
    name: "relay_publish_intent",
    arguments: {
      task: "Migrate session storage to Redis",
      branch: "feature/redis-sessions",
      baseCommit: "af31d4e",
      plannedFiles: ["src/auth/session.ts", "src/models/session.ts"],
      interfaces: ["Session"],
      dependencies: ["User"],
      plan: ["Add a Redis-backed SessionRepository", "Keep the fake repository for tests"],
    },
  },
};

export const ALICE_INTENT_RESULT = {
  publicSummary: "I will add Google OAuth login using the existing Session contract.",
  taskState: "working" as const,
  nextAction: {
    name: "relay_publish_intent",
    arguments: {
      task: "Add Google OAuth",
      branch: "feature/google-oauth",
      baseCommit: "af31d4e",
      plannedFiles: ["src/auth/oauth.ts", "src/routes/login.ts"],
      interfaces: ["Session", "POST /login", "GET /oauth/callback"],
      dependencies: ["User", "Session"],
      plan: ["Add the OAuth provider", "Create a session after the OAuth callback"],
    },
  },
};

export const BOB_STATUS_RESULT = {
  publicSummary: "Redis session storage is about 60% done; the Session shape is unchanged.",
  taskState: "working" as const,
  progress: 60,
  changedFiles: ["src/auth/session.ts", "src/models/session.ts"],
  interfaces: ["Session"],
  blockers: [],
  lastVerifiedAt: "2026-08-28T01:59:30.000Z",
};

/** Schema-valid, factually wrong. Asserted to never reach the delivered pack. */
export const FABRICATED_COMMIT = "dea4bee";
export const FABRICATED_SHA = "f".repeat(64);

export const BOB_CONTEXT_PACK_RESULT = {
  topic: "Redis session architecture",
  summary:
    "Sessions are created through SessionRepository and stored in Redis with a TTL taken from SESSION_TTL_SECONDS.",
  implementationSteps: [
    "Use the existing SessionRepository",
    "Apply the configured session expiry",
    "Do not access Redis directly from route handlers",
  ],
  validationChecklist: [
    "Refresh token expiry matches the Redis entry",
    "Logout removes the session key",
    "Tests use the fake SessionRepository",
  ],
  /**
   * Deliberately plausible and deliberately wrong. The commit and digest below
   * pass Duy's schema, so the only thing standing between them and Alice is the
   * validator replacing both from the trusted manifest.
   */
  sources: [
    { path: "docs/architecture/auth.md", commit: FABRICATED_COMMIT, sha256: FABRICATED_SHA },
    {
      path: "src/auth/session-repository.ts",
      commit: FABRICATED_COMMIT,
      sha256: FABRICATED_SHA,
    },
  ],
  taskScope: "task:google-oauth",
};

export const ALICE_REPLAN_RESULT = {
  publicSummary: "Bob's change means the callback must supply a device id.",
  taskState: "working" as const,
  originalPlan: ["Create a session after the OAuth callback"],
  revisedPlan: [
    "Extract deviceId from the validated request context",
    "Pass deviceId to SessionRepository.create",
    "Update OAuth callback tests",
  ],
  affectedFiles: ["src/routes/oauth-callback.ts", "tests/auth/oauth.test.ts"],
};
