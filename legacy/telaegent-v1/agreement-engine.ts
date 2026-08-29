import type {
  Agreement,
  AgreementDecisionInput,
  DependencyLink,
  OwnershipAssignment,
} from "./types.js";

export interface AgreementProposalInput {
  ownership: OwnershipAssignment[];
  dependencyLinks: DependencyLink[];
  requiredRules: string[];
  rationale: string;
}

export interface CreateAgreementInput extends AgreementProposalInput {
  agreementId: string;
  projectId: string;
  conversationId: string;
  coordinationRequestId: string;
  participantOwnerIds: [string, string];
  createdAt: string;
}

export class AgreementRuleError extends Error {
  constructor(
    public readonly code: "INVALID_REQUEST" | "INVALID_STATE" | "STALE_VERSION",
    message: string,
  ) {
    super(message);
    this.name = "AgreementRuleError";
  }
}

function assertDistinctParticipants(participants: [string, string]): void {
  if (participants[0] === participants[1]) {
    throw new AgreementRuleError(
      "INVALID_REQUEST",
      "A dual-owner agreement requires two different owners",
    );
  }
}

function assertOwnershipMatchesParticipants(
  ownership: OwnershipAssignment[],
  participants: [string, string],
): void {
  const expected = [...participants].sort();
  const actual = [...new Set(ownership.map((assignment) => assignment.ownerId))].sort();
  if (
    ownership.length !== 2 ||
    actual.length !== 2 ||
    expected.some((ownerId, index) => actual[index] !== ownerId)
  ) {
    throw new AgreementRuleError(
      "INVALID_REQUEST",
      "Ownership assignments must cover both participant owners exactly once",
    );
  }
}

function sorted(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, "en-US"));
}

function canonicalProposal(proposal: AgreementProposalInput): string {
  return JSON.stringify({
    ownership: proposal.ownership
      .map((assignment) => ({
        ownerId: assignment.ownerId,
        agentId: assignment.agentId,
        files: sorted(assignment.files),
        interfaces: sorted(assignment.interfaces.map((value) => value.toLocaleLowerCase("en-US"))),
      }))
      .sort((left, right) => left.ownerId.localeCompare(right.ownerId, "en-US")),
    dependencyLinks: proposal.dependencyLinks
      .map((link) => ({
        ...link,
        interface: link.interface.toLocaleLowerCase("en-US"),
      }))
      .sort((left, right) =>
        `${left.consumerIntentId}:${left.providerIntentId}:${left.interface}`.localeCompare(
          `${right.consumerIntentId}:${right.providerIntentId}:${right.interface}`,
          "en-US",
        ),
      ),
    requiredRules: sorted(proposal.requiredRules),
    rationale: proposal.rationale.trim(),
  });
}

function proposalFromAgreement(agreement: Agreement): AgreementProposalInput {
  return {
    ownership: agreement.ownership,
    dependencyLinks: agreement.dependencyLinks,
    requiredRules: agreement.requiredRules,
    rationale: agreement.rationale,
  };
}

export function createAgreement(input: CreateAgreementInput): Agreement {
  assertDistinctParticipants(input.participantOwnerIds);
  assertOwnershipMatchesParticipants(input.ownership, input.participantOwnerIds);
  return {
    agreementId: input.agreementId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    coordinationRequestId: input.coordinationRequestId,
    participantOwnerIds: [...input.participantOwnerIds],
    proposalVersion: 1,
    ownership: structuredClone(input.ownership),
    dependencyLinks: structuredClone(input.dependencyLinks),
    requiredRules: [...input.requiredRules],
    rationale: input.rationale,
    approvals: [],
    state: "proposed",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function reviseAgreement(
  agreement: Agreement,
  proposal: AgreementProposalInput,
  updatedAt: string,
): Agreement {
  if (agreement.state === "active" || agreement.state === "completed") {
    throw new AgreementRuleError(
      "INVALID_STATE",
      "An active or completed agreement cannot be revised in place",
    );
  }
  assertOwnershipMatchesParticipants(proposal.ownership, agreement.participantOwnerIds);
  if (canonicalProposal(proposalFromAgreement(agreement)) === canonicalProposal(proposal)) {
    return structuredClone(agreement);
  }
  return {
    ...structuredClone(agreement),
    proposalVersion: agreement.proposalVersion + 1,
    ownership: structuredClone(proposal.ownership),
    dependencyLinks: structuredClone(proposal.dependencyLinks),
    requiredRules: [...proposal.requiredRules],
    rationale: proposal.rationale,
    approvals: [],
    state: "proposed",
    updatedAt,
  };
}

export function recordAgreementDecision(
  agreement: Agreement,
  input: AgreementDecisionInput,
  decidedAt: string,
): Agreement {
  if (input.targetVersion !== agreement.proposalVersion) {
    throw new AgreementRuleError(
      "STALE_VERSION",
      "The decision targets an old agreement proposal version",
    );
  }
  if (!agreement.participantOwnerIds.includes(input.ownerId)) {
    throw new AgreementRuleError("INVALID_REQUEST", "Only a participant owner may decide");
  }

  const existing = agreement.approvals.find(
    (approval) =>
      approval.ownerId === input.ownerId &&
      approval.proposalVersion === agreement.proposalVersion,
  );
  if (existing) {
    if (existing.decision === input.decision) return structuredClone(agreement);
    throw new AgreementRuleError(
      "INVALID_STATE",
      "An owner cannot replace an existing decision on the same proposal version",
    );
  }
  if (agreement.state !== "proposed") {
    throw new AgreementRuleError(
      "INVALID_STATE",
      "Decisions are accepted only while an agreement is proposed",
    );
  }

  const approvals = [
    ...agreement.approvals,
    {
      ownerId: input.ownerId,
      decision: input.decision,
      proposalVersion: agreement.proposalVersion,
      decidedAt,
    },
  ];
  const rejected = approvals.some((approval) => approval.decision === "reject");
  const approvedOwnerIds = new Set(
    approvals
      .filter((approval) => approval.decision === "approve")
      .map((approval) => approval.ownerId),
  );
  const active = agreement.participantOwnerIds.every((ownerId) => approvedOwnerIds.has(ownerId));

  return {
    ...structuredClone(agreement),
    approvals,
    state: rejected ? "rejected" : active ? "active" : "proposed",
    updatedAt: decidedAt,
  };
}

export function completeAgreement(agreement: Agreement, completedAt: string): Agreement {
  if (agreement.state !== "active") {
    throw new AgreementRuleError("INVALID_STATE", "Only an active agreement can complete");
  }
  return { ...structuredClone(agreement), state: "completed", updatedAt: completedAt };
}
