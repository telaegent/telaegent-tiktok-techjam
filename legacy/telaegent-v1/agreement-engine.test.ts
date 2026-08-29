import { describe, expect, it } from "vitest";
import {
  AgreementRuleError,
  completeAgreement,
  createAgreement,
  recordAgreementDecision,
  reviseAgreement,
  type AgreementProposalInput,
} from "./agreement-engine.js";

const time = (minute: number) => `2026-08-28T02:${String(minute).padStart(2, "0")}:00.000Z`;
const proposal = (rule = "Bob publishes Session changes"): AgreementProposalInput => ({
  ownership: [
    {
      ownerId: "alice",
      agentId: "alice-agent",
      files: ["src/auth/oauth.ts"],
      interfaces: ["OAuthProvider"],
    },
    {
      ownerId: "bob",
      agentId: "bob-agent",
      files: ["src/auth/session.ts"],
      interfaces: ["Session"],
    },
  ],
  dependencyLinks: [
    {
      consumerIntentId: "intent_alice",
      providerIntentId: "intent_bob",
      interface: "Session",
    },
  ],
  requiredRules: [rule],
  rationale: "Keep OAuth routes separate from session persistence.",
});
const agreement = () =>
  createAgreement({
    agreementId: "agreement_01",
    projectId: "phoenix",
    conversationId: "conv_phoenix",
    coordinationRequestId: "coord_01",
    participantOwnerIds: ["alice", "bob"],
    ...proposal(),
    createdAt: time(0),
  });

describe("agreement engine", () => {
  it("starts proposals at version one with no approvals", () => {
    expect(agreement()).toMatchObject({
      proposalVersion: 1,
      approvals: [],
      state: "proposed",
    });
  });

  it("does not activate after only one approval", () => {
    const afterAlice = recordAgreementDecision(
      agreement(),
      { ownerId: "alice", decision: "approve", targetVersion: 1 },
      time(1),
    );
    expect(afterAlice.state).toBe("proposed");
    expect(afterAlice.approvals).toHaveLength(1);
  });

  it("activates only after both participant owners approve the same version", () => {
    const afterAlice = recordAgreementDecision(
      agreement(),
      { ownerId: "alice", decision: "approve", targetVersion: 1 },
      time(1),
    );
    const afterBob = recordAgreementDecision(
      afterAlice,
      { ownerId: "bob", decision: "approve", targetVersion: 1 },
      time(2),
    );
    expect(afterBob.state).toBe("active");
    expect(completeAgreement(afterBob, time(3)).state).toBe("completed");
  });

  it("rejects stale decisions", () => {
    expect(() =>
      recordAgreementDecision(
        agreement(),
        { ownerId: "alice", decision: "approve", targetVersion: 2 },
        time(1),
      ),
    ).toThrowError(AgreementRuleError);
    try {
      recordAgreementDecision(
        agreement(),
        { ownerId: "alice", decision: "approve", targetVersion: 2 },
        time(1),
      );
    } catch (error) {
      expect(error).toMatchObject({ code: "STALE_VERSION" });
    }
  });

  it("never activates a rejected proposal", () => {
    const rejected = recordAgreementDecision(
      agreement(),
      { ownerId: "alice", decision: "reject", targetVersion: 1 },
      time(1),
    );
    expect(rejected.state).toBe("rejected");
    expect(() =>
      recordAgreementDecision(
        rejected,
        { ownerId: "bob", decision: "approve", targetVersion: 1 },
        time(2),
      ),
    ).toThrow(/only while an agreement is proposed/);
  });

  it("increments changed proposals and invalidates prior approvals", () => {
    const afterAlice = recordAgreementDecision(
      agreement(),
      { ownerId: "alice", decision: "approve", targetVersion: 1 },
      time(1),
    );
    const revised = reviseAgreement(afterAlice, proposal("Publish every contract change"), time(2));
    expect(revised).toMatchObject({ proposalVersion: 2, approvals: [], state: "proposed" });
  });

  it("treats an identical proposal and identical decision as idempotent", () => {
    const original = agreement();
    expect(reviseAgreement(original, proposal(), time(1))).toEqual(original);
    const afterAlice = recordAgreementDecision(
      original,
      { ownerId: "alice", decision: "approve", targetVersion: 1 },
      time(1),
    );
    expect(
      recordAgreementDecision(
        afterAlice,
        { ownerId: "alice", decision: "approve", targetVersion: 1 },
        time(2),
      ),
    ).toEqual(afterAlice);
  });

  it("rejects a conflicting replacement decision", () => {
    const afterAlice = recordAgreementDecision(
      agreement(),
      { ownerId: "alice", decision: "approve", targetVersion: 1 },
      time(1),
    );
    expect(() =>
      recordAgreementDecision(
        afterAlice,
        { ownerId: "alice", decision: "reject", targetVersion: 1 },
        time(2),
      ),
    ).toThrow(/cannot replace/);
  });

  it("requires two distinct owners and matching ownership assignments", () => {
    expect(() =>
      createAgreement({
        agreementId: "bad",
        projectId: "phoenix",
        conversationId: "conv",
        coordinationRequestId: "coord",
        participantOwnerIds: ["alice", "alice"],
        ...proposal(),
        createdAt: time(0),
      }),
    ).toThrow(/two different owners/);
  });
});
