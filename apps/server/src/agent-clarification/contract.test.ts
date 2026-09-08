/**
 * Plan section 6 and 7.3/7.4 contract tests.
 *
 * Everything here assumes the model is wrong or hostile. The dialogue lane runs
 * with no tools and no repository, so this schema plus `restrictToApprovedBasis`
 * are the only things standing between a model-authored object and a persisted
 * row. A property that holds only when the model cooperates is not a property.
 */

import { describe, expect, it } from "vitest";

import {
  AGENT_CLARIFICATION_LIMITS,
  CLARIFICATION_REASON_CODES,
  clarificationDialogueOutputSchema,
  hashClarificationText,
  normalizeClarificationText,
  peerClarificationSchema,
  restrictToApprovedBasis,
} from "./contract.js";

const ID = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
] as const;

function peerClarification(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    question: "Which of the two staging databases should the migration target?",
    reasonCode: "ambiguity",
    sharedBasisMessageIds: [ID[0]],
    ...overrides,
  };
}

function dialogueOutput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    outcome: "answered",
    replyToStepId: ID[1],
    answer: "The one behind the read replica.",
    counterQuestion: null,
    privateExplanation: "Answered from the message the peer already shared.",
    sharedBasisMessageIds: [ID[0]],
    humanRequiredReason: null,
    riskFlags: [],
    ...overrides,
  };
}

describe("peer clarification budgets", () => {
  it("measures the question in UTF-8 bytes, not characters", () => {
    // 300 characters, 600 bytes. A character-only ceiling of 500 would accept
    // this and then trip the octet_length constraint in the database, which
    // surfaces as an opaque RPC failure instead of a rejected question. This
    // is the ordinary case for a bilingual conversation, not a corner case.
    const accented = "é".repeat(300);
    expect(accented.length).toBeLessThan(
      AGENT_CLARIFICATION_LIMITS.maxQuestionBytes,
    );
    expect(Buffer.byteLength(accented, "utf8")).toBeGreaterThan(
      AGENT_CLARIFICATION_LIMITS.maxQuestionBytes,
    );

    expect(
      peerClarificationSchema.safeParse(
        peerClarification({ question: accented }),
      ).success,
    ).toBe(false);
  });

  it("accepts a question that exactly spends the byte budget", () => {
    const exact = "a".repeat(AGENT_CLARIFICATION_LIMITS.maxQuestionBytes);
    expect(
      peerClarificationSchema.safeParse(peerClarification({ question: exact }))
        .success,
    ).toBe(true);
  });

  it("rejects an empty or whitespace-only question", () => {
    for (const question of ["", "   ", "\n\t"]) {
      expect(
        peerClarificationSchema.safeParse(peerClarification({ question }))
          .success,
      ).toBe(false);
    }
  });

  it("bounds the answer and the private explanation separately", () => {
    const overAnswer = "a".repeat(AGENT_CLARIFICATION_LIMITS.maxAnswerBytes + 1);
    expect(
      clarificationDialogueOutputSchema.safeParse(
        dialogueOutput({ answer: overAnswer }),
      ).success,
    ).toBe(false);

    const overExplanation = "a".repeat(
      AGENT_CLARIFICATION_LIMITS.maxPrivateExplanationBytes + 1,
    );
    expect(
      clarificationDialogueOutputSchema.safeParse(
        dialogueOutput({ privateExplanation: overExplanation }),
      ).success,
    ).toBe(false);
  });
});

describe("peer clarification shape", () => {
  it("accepts only the three closed reason codes", () => {
    for (const reasonCode of CLARIFICATION_REASON_CODES) {
      expect(
        peerClarificationSchema.safeParse(peerClarification({ reasonCode }))
          .success,
      ).toBe(true);
    }
    for (const reasonCode of ["urgent", "needs_file", "", null]) {
      expect(
        peerClarificationSchema.safeParse(peerClarification({ reasonCode }))
          .success,
      ).toBe(false);
    }
  });

  it("rejects duplicate, malformed, or over-cap shared basis ids", () => {
    expect(
      peerClarificationSchema.safeParse(
        peerClarification({ sharedBasisMessageIds: [ID[0], ID[0]] }),
      ).success,
    ).toBe(false);

    expect(
      peerClarificationSchema.safeParse(
        peerClarification({ sharedBasisMessageIds: ["../../etc/passwd"] }),
      ).success,
    ).toBe(false);

    const tooMany = Array.from(
      { length: AGENT_CLARIFICATION_LIMITS.maxSharedBasisMessageIds + 1 },
      (_unused, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(
      peerClarificationSchema.safeParse(
        peerClarification({ sharedBasisMessageIds: tooMany }),
      ).success,
    ).toBe(false);
  });

  it("refuses any field the plan does not define", () => {
    // The strict object is what stops a model smuggling a path, a tool call or
    // a send candidate through a lane that is supposed to have none of them.
    for (const smuggled of [
      { sendCandidate: "ship it" },
      { sourcePaths: ["/home/mark/secret/.env"] },
      { resourceRequests: [{ kind: "file", hint: "config" }] },
      { toolCalls: [] },
    ]) {
      expect(
        peerClarificationSchema.safeParse(peerClarification(smuggled)).success,
      ).toBe(false);
      expect(
        clarificationDialogueOutputSchema.safeParse(dialogueOutput(smuggled))
          .success,
      ).toBe(false);
    }
  });
});

describe("dialogue outcome exclusivity", () => {
  it("accepts each outcome in its one consistent shape", () => {
    expect(
      clarificationDialogueOutputSchema.safeParse(dialogueOutput()).success,
    ).toBe(true);
    expect(
      clarificationDialogueOutputSchema.safeParse(
        dialogueOutput({
          outcome: "counter_question",
          answer: null,
          counterQuestion: peerClarification(),
        }),
      ).success,
    ).toBe(true);
    expect(
      clarificationDialogueOutputSchema.safeParse(
        dialogueOutput({
          outcome: "human_required",
          answer: null,
          humanRequiredReason: "private_context",
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects an answer and a counter-question in the same turn", () => {
    expect(
      clarificationDialogueOutputSchema.safeParse(
        dialogueOutput({ counterQuestion: peerClarification() }),
      ).success,
    ).toBe(false);
  });

  it("rejects an outcome whose own evidence is missing", () => {
    expect(
      clarificationDialogueOutputSchema.safeParse(
        dialogueOutput({ answer: null }),
      ).success,
    ).toBe(false);
    expect(
      clarificationDialogueOutputSchema.safeParse(
        dialogueOutput({ outcome: "counter_question", answer: null }),
      ).success,
    ).toBe(false);
    expect(
      clarificationDialogueOutputSchema.safeParse(
        dialogueOutput({ outcome: "human_required", answer: null }),
      ).success,
    ).toBe(false);
  });

  it("rejects a human_required reason attached to a plain answer", () => {
    expect(
      clarificationDialogueOutputSchema.safeParse(
        dialogueOutput({ humanRequiredReason: "new_authority" }),
      ).success,
    ).toBe(false);
  });

  it("requires the backend-supplied parent step id to be a uuid", () => {
    // `replyToStepId` is the only proof that the answer belongs to the question
    // that was actually dispatched, so a free-form string cannot be accepted.
    expect(
      clarificationDialogueOutputSchema.safeParse(
        dialogueOutput({ replyToStepId: "step-1" }),
      ).success,
    ).toBe(false);
  });
});

describe("restrictToApprovedBasis", () => {
  it("drops every id outside the approved capsule and keeps the rest", () => {
    const narrowed = restrictToApprovedBasis(
      { sharedBasisMessageIds: [ID[0], ID[2], ID[1]], question: "which one?" },
      new Set([ID[0], ID[1]]),
    );

    expect(narrowed.sharedBasisMessageIds).toEqual([ID[0], ID[1]]);
    // Narrowing is not editing: the rest of the object is untouched.
    expect(narrowed.question).toBe("which one?");
  });

  it("empties the hints rather than failing when none were approved", () => {
    // They are evidence hints, never authorization, so an unrecognised id is a
    // model mistake to discard and not a reason to abandon the exchange.
    expect(
      restrictToApprovedBasis(
        { sharedBasisMessageIds: [ID[2], ID[3]] },
        new Set([ID[0]]),
      ).sharedBasisMessageIds,
    ).toEqual([]);

    expect(
      restrictToApprovedBasis(
        { sharedBasisMessageIds: [ID[0]] },
        new Set<string>(),
      ).sharedBasisMessageIds,
    ).toEqual([]);
  });
});

describe("plan section 6 hash normalization", () => {
  it("treats transport shape as no progress but preserves case", () => {
    // CRLF, outer whitespace and NFD all describe the same sentence, so a
    // question repeated in a different transport shape is still no progress.
    expect(hashClarificationText("Should the migration\ntarget staging?")).toBe(
      hashClarificationText("  Should the migration\r\ntarget staging?  "),
    );
    // Precomposed on one side, decomposed on the other. NFC has to run
    // before the digest, or one word hashes two ways depending on which
    // keyboard typed it.
    expect(hashClarificationText("caf\u00e9 ready\r\nnow")).toBe(
      hashClarificationText("cafe\u0301 ready\nnow  "),
    );

    // Case carries meaning in identifiers, so it must survive normalization.
    expect(hashClarificationText("Deploy API")).not.toBe(
      hashClarificationText("deploy api"),
    );
  });

  it("normalizes line endings, composition and outer whitespace only", () => {
    expect(normalizeClarificationText("a\r\nb")).toBe("a\nb");
    expect(normalizeClarificationText("  padded  ")).toBe("padded");
    expect(normalizeClarificationText("cafe\u0301")).toBe("caf\u00e9");
    // Interior whitespace is content, not transport.
    expect(normalizeClarificationText("a  b")).toBe("a  b");
  });

  it("produces a lowercase sha-256 digest the database regex accepts", () => {
    expect(hashClarificationText("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});
