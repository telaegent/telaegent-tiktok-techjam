/**
 * The peer clarification policy block, and the citable ids underneath it.
 *
 * The live probe exercises this every time it reports `cites=n/n approved`, but
 * the probe costs money and never runs in CI. Everything asserted here is a
 * failure that looks exactly like success from the outside: a missing id list
 * produces empty citations or invented ones that `restrictToApprovedBasis`
 * discards in silence, and a policy block that leaks onto turns it does not
 * govern changes the scored prompt for every case in the evaluation corpus.
 */

import { describe, expect, it } from "vitest";
import { PROTOCOL_LIMITS, type ProjectFacts } from "./contract.js";
import {
  buildPreparedPrivateTurn,
  type DurableConversationContext,
} from "./runtime-adapter.js";

const FACTS: ProjectFacts = {
  repositoryFullName: "telaegent/backend",
  githubRepositoryId: "1345851099",
  branch: "feat/auth",
  commit: "0123456789abcdef0123456789abcdef01234567",
  ownerName: "Henry",
  collaboratorName: "Mark",
};

const sharedTurn = (index: number) => ({
  id: `msg-${index}`,
  author: "Mark",
  origin: "agent" as const,
  text: `Shared message ${index}.`,
  at: `2026-09-0${(index % 8) + 1}T09:00:00.000Z`,
});

function context(
  overrides: Partial<DurableConversationContext> = {},
): DurableConversationContext {
  return {
    role: "recipient",
    facts: FACTS,
    sharedHistory: [sharedTurn(1)],
    projectFacts: ["repository telaegent/backend", "branch feat/auth"],
    incomingMessage: "Does that apply to other devices too?",
    ...overrides,
  };
}

const promptFor = (
  options: Partial<Parameters<typeof buildPreparedPrivateTurn>[0]> = {},
) =>
  buildPreparedPrivateTurn({
    context: context(),
    correlationId: "corr-1",
    ...options,
  }).runtimePrompt;

describe("peer clarification prompt policy", () => {
  it("adds nothing at all when the loop is not offered", () => {
    // The scored formats have to stay byte-identical on every turn that is not
    // offered a peer question, or the evaluation corpus stops measuring what it
    // measured before and the regression is invisible.
    const withoutFlag = promptFor();
    const explicitlyOff = promptFor({ allowPeerClarification: false });
    const on = promptFor({ allowPeerClarification: true });

    expect(withoutFlag).toBe(explicitlyOff);
    expect(withoutFlag).not.toContain("TASK-SCOPED AGENT CLARIFICATION IS AVAILABLE");
    expect(on).toContain("TASK-SCOPED AGENT CLARIFICATION IS AVAILABLE");
    expect(on.startsWith(withoutFlag)).toBe(true);
  });

  it("never offers the loop to a sender", () => {
    // Only a recipient has a peer whose agent holds the answer. A sender is
    // drafting the first message; there is no counterpart turn to ask.
    const prompt = promptFor({
      context: context({ role: "sender", incomingMessage: undefined }),
      allowPeerClarification: true,
    });
    expect(prompt).not.toContain("TASK-SCOPED AGENT CLARIFICATION IS AVAILABLE");
  });

  it("states the exclusivity rule the provider most often breaks", () => {
    // Codex failed all three probe cases by stapling a peer question to a
    // finished reply. `normalizeRecipientOutput` catches it on the way back;
    // this line is the half that stops it being produced.
    const prompt = promptFor({ allowPeerClarification: true });
    expect(prompt).toContain(
      "peerClarification and sendCandidate are mutually exclusive",
    );
    expect(prompt).toContain(
      "Do not use peerClarification to request a file, permission, credential, secret,",
    );
  });

  it("shows the exact ids it then demands the agent cite", () => {
    // Nothing else in any format renders `SharedTurn.id`. Without this block the
    // instruction to cite approved message ids asks for something the agent has
    // never been shown.
    const prompt = promptFor({
      context: context({ sharedHistory: [sharedTurn(1), sharedTurn(2)] }),
      allowPeerClarification: true,
    });

    expect(prompt).toContain("CITABLE SHARED MESSAGE IDS");
    expect(prompt).toContain("msg-1  Mark (agent) at");
    expect(prompt).toContain("msg-2  Mark (agent) at");
    expect(prompt).toContain("Cite only from this list. Any other id is discarded.");
    expect(prompt.indexOf("msg-1")).toBeLessThan(prompt.indexOf("msg-2"));
  });

  it("says plainly that there is nothing to cite yet", () => {
    // An empty list with no explanation reads as an omission, and the model
    // fills the gap by inventing an id. Every invented id is then discarded, so
    // the failure surfaces as a citation-free answer rather than an error.
    const prompt = promptFor({
      context: context({ sharedHistory: [] }),
      allowPeerClarification: true,
    });

    expect(prompt).toContain(
      "No shared message has been approved yet, so sharedBasisMessageIds must be [].",
    );
    expect(prompt).not.toContain("CITABLE SHARED MESSAGE IDS");
  });

  it("lists only the window the prompt actually quotes", () => {
    // Listing an id whose text was summarised out of the prompt invites a
    // citation to evidence the agent cannot read.
    const window = PROTOCOL_LIMITS.recentSharedTurns;
    const history = Array.from({ length: window + 3 }, (_, index) =>
      sharedTurn(index + 1),
    );
    const prompt = promptFor({
      context: context({ sharedHistory: history }),
      allowPeerClarification: true,
    });

    const listed = prompt.slice(prompt.indexOf("CITABLE SHARED MESSAGE IDS"));
    for (const dropped of [1, 2, 3]) {
      expect(listed).not.toContain(`msg-${dropped}  `);
    }
    expect(listed).toContain(`msg-4  `);
    expect(listed).toContain(`msg-${window + 3}  `);
  });
});
