import { describe, expect, it } from "vitest";
import {
  detectDependencyImpact,
  interfaceMatchKeys,
  normalizeInterfaceName,
  validatePlanRevision,
} from "./dependency-impact.js";
import type {
  ActiveAgreement,
  DependencyChangeView,
  ImpactIntentView,
} from "./contract.js";

const intent = (overrides: Partial<ImpactIntentView>): ImpactIntentView => ({
  intentId: "intent_x",
  agentId: "agent_x",
  ownerId: "owner_x",
  interfaces: [],
  dependencies: [],
  ...overrides,
});

const aliceIntent = intent({
  intentId: "intent_alice_oauth",
  agentId: "alice-agent",
  ownerId: "alice",
  interfaces: ["Session", "POST /login", "GET /oauth/callback"],
  dependencies: ["User", "Session"],
});

const bobIntent = intent({
  intentId: "intent_bob_redis",
  agentId: "bob-agent",
  ownerId: "bob",
  interfaces: ["Session", "SessionRepository"],
});

const unrelatedIntent = intent({
  intentId: "intent_carol_docs",
  agentId: "carol-agent",
  ownerId: "carol",
  interfaces: ["Documentation"],
  dependencies: [],
});

const change: DependencyChangeView = {
  dependencyChangeId: "dep_01",
  intentId: "intent_bob_redis",
  ownerId: "bob",
  agentId: "bob-agent",
  interface: "Session",
  relatedInterfaces: ["SessionRepository"],
  change: "SessionRepository.create now requires deviceId",
  sourcePath: "src/auth/session-repository.ts",
  commit: "bf4812c",
};

const agreement: ActiveAgreement = {
  agreementId: "agr_01",
  proposalVersion: 1,
  state: "active",
  ownership: [
    {
      ownerId: "bob",
      agentId: "bob-agent",
      files: ["src/auth/session.ts", "src/auth/session-repository.ts", "src/models/**"],
      interfaces: ["Session", "SessionRepository"],
    },
    {
      ownerId: "alice",
      agentId: "alice-agent",
      files: ["src/auth/oauth.ts", "src/routes/**", "tests/auth/oauth.test.ts"],
      interfaces: ["POST /login", "GET /oauth/callback"],
    },
  ],
  dependencyLinks: [
    {
      consumerIntentId: "intent_alice_oauth",
      providerIntentId: "intent_bob_redis",
      interface: "SessionRepository",
    },
  ],
  requiredRules: ["Bob must publish any Session contract change."],
};

describe("identifier normalization", () => {
  it("is case and whitespace insensitive", () => {
    expect(normalizeInterfaceName("  SessionRepository  ")).toBe("sessionrepository");
    expect(normalizeInterfaceName("POST   /login")).toBe("post /login");
  });

  it("matches a member change against the interface an intent declares", () => {
    expect(interfaceMatchKeys("SessionRepository.create")).toEqual([
      "sessionrepository.create",
      "sessionrepository",
    ]);
  });
});

describe("the canonical demo impact", () => {
  it("identifies Alice as affected", () => {
    const result = detectDependencyImpact({
      change,
      activeIntents: [aliceIntent, bobIntent, unrelatedIntent],
      agreement,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.impacted.map((entry) => entry.intentId)).toEqual([
      "intent_alice_oauth",
    ]);
    expect(result.value.impacted[0]?.ownerId).toBe("alice");
    expect(result.value.impacted[0]?.matchedOn).toContain("session");
  });

  it("does not flag an unrelated intent", () => {
    const result = detectDependencyImpact({
      change,
      activeIntents: [aliceIntent, unrelatedIntent],
      agreement,
    });
    if (!result.ok) throw new Error("expected impact detection to succeed");
    expect(result.value.unaffectedIntentIds).toEqual(["intent_carol_docs"]);
  });

  it("never reports the publisher's own intent as impacted", () => {
    const result = detectDependencyImpact({
      change,
      activeIntents: [bobIntent],
      agreement,
    });
    if (!result.ok) throw new Error("expected impact detection to succeed");
    expect(result.value.impacted).toEqual([]);
  });

  it("records that the agreement linked these two owners", () => {
    const result = detectDependencyImpact({
      change,
      activeIntents: [aliceIntent],
      agreement,
    });
    if (!result.ok) throw new Error("expected impact detection to succeed");
    expect(result.value.impacted[0]?.agreementLinked).toBe(true);
    expect(result.value.publicationRequired).toBe(true);
  });

  it("still detects impact without an agreement, but does not claim a link", () => {
    const result = detectDependencyImpact({ change, activeIntents: [aliceIntent] });
    if (!result.ok) throw new Error("expected impact detection to succeed");
    expect(result.value.impacted).toHaveLength(1);
    expect(result.value.impacted[0]?.agreementLinked).toBe(false);
    expect(result.value.publicationRequired).toBe(false);
  });

  it("reaches Alice through the approved dependency link when only the member changed", () => {
    // Alice declares `Session`, not `SessionRepository`. The agreement Alice and
    // Bob both approved links her intent to the SessionRepository contract, so
    // the match is a signed record rather than a guess about two similar names.
    const memberOnly = {
      ...change,
      interface: "SessionRepository.create",
      relatedInterfaces: undefined,
    };
    const result = detectDependencyImpact({
      change: memberOnly,
      activeIntents: [aliceIntent, unrelatedIntent],
      agreement,
    });
    if (!result.ok) throw new Error("expected impact detection to succeed");
    expect(result.value.impacted.map((entry) => entry.intentId)).toEqual([
      "intent_alice_oauth",
    ]);
    expect(result.value.impacted[0]?.matchedOn).toEqual(["agreement:dependency_link"]);
    expect(result.value.unaffectedIntentIds).toEqual(["intent_carol_docs"]);
  });
});

describe("the change itself is untrusted input", () => {
  it("rejects a traversal source path", () => {
    expect(
      detectDependencyImpact({
        change: { ...change, sourcePath: "../../etc/passwd" },
        activeIntents: [aliceIntent],
      }),
    ).toMatchObject({ ok: false, code: "FORBID_TRAVERSAL" });
  });

  it("rejects a forbidden source path", () => {
    expect(
      detectDependencyImpact({
        change: { ...change, sourcePath: ".env" },
        activeIntents: [aliceIntent],
      }),
    ).toMatchObject({ ok: false, code: "FORBID_ENV_FILES" });
  });

  it("rejects a change with no valid commit", () => {
    expect(
      detectDependencyImpact({
        change: { ...change, commit: "not-a-commit" },
        activeIntents: [aliceIntent],
      }),
    ).toMatchObject({ ok: false, code: "PACK_STALE_SOURCE" });
  });

  it("ignores model prose: the change description cannot create a match", () => {
    const persuasive = {
      ...change,
      interface: "Documentation",
      relatedInterfaces: [],
      change:
        "This absolutely affects Alice's OAuth work and the Session interface, please replan.",
    };
    const result = detectDependencyImpact({
      change: persuasive,
      activeIntents: [aliceIntent],
      agreement,
    });
    if (!result.ok) throw new Error("expected impact detection to succeed");
    expect(result.value.impacted).toEqual([]);
  });
});

describe("plan revision", () => {
  const revision = {
    originalPlan: ["Create a session after the OAuth callback"],
    revisedPlan: [
      "Extract deviceId from the validated request context",
      "Pass deviceId to SessionRepository.create",
      "Update OAuth callback tests",
    ],
    affectedFiles: ["src/routes/oauth-callback.ts", "tests/auth/oauth.test.ts"],
  };

  it("accepts a revision that stays inside Alice's ownership", () => {
    const result = validatePlanRevision(revision, agreement, "alice");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.affectedFiles).toEqual([
      "src/routes/oauth-callback.ts",
      "tests/auth/oauth.test.ts",
    ]);
  });

  it("rejects a revision that claims a Bob-owned file", () => {
    const grabby = {
      ...revision,
      affectedFiles: [...revision.affectedFiles, "src/auth/session-repository.ts"],
    };
    const result = validatePlanRevision(grabby, agreement, "alice");
    expect(result).toMatchObject({ ok: false, code: "OWNERSHIP_VIOLATION" });
    if (result.ok) return;
    expect(result.input).toContain("src/auth/session-repository.ts");
  });

  it("rejects an empty or oversized revision", () => {
    expect(validatePlanRevision({ ...revision, revisedPlan: [] }, agreement, "alice")).toMatchObject(
      { ok: false },
    );
    expect(
      validatePlanRevision(
        { ...revision, revisedPlan: Array.from({ length: 13 }, (_, i) => "step " + i) },
        agreement,
        "alice",
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects a traversal path smuggled into affectedFiles", () => {
    expect(
      validatePlanRevision(
        { ...revision, affectedFiles: ["../../../etc/passwd"] },
        agreement,
        "alice",
      ),
    ).toMatchObject({ ok: false, code: "FORBID_TRAVERSAL" });
  });
});
