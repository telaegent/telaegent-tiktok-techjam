import { describe, expect, it } from "vitest";
import { INVESTIGATION_ROLE_INSTRUCTION, buildInvestigationPrompt } from "./investigate.js";

describe("investigation prompt", () => {
  it("tells the agent it cannot send and is not writing the answer", () => {
    expect(INVESTIGATION_ROLE_INSTRUCTION).toMatch(/cannot send/i);
    expect(INVESTIGATION_ROLE_INSTRUCTION).toMatch(/not writing the answer/i);
  });

  it("forbids copying secret values into the note", () => {
    expect(INVESTIGATION_ROLE_INSTRUCTION).toMatch(/never copy a secret value/i);
  });

  it("carries the draft prompt through so the agent knows what to look for", () => {
    const prompt = buildInvestigationPrompt("Teammate asks: how does session refresh work?");
    expect(prompt).toContain("how does session refresh work?");
    expect(prompt).toContain(INVESTIGATION_ROLE_INSTRUCTION);
  });

  it("is stable for the same input", () => {
    expect(buildInvestigationPrompt("x")).toBe(buildInvestigationPrompt("x"));
  });
});
