import { describe, expect, it } from "vitest";
import {
  assertContextRequestTransition,
  assertCoordinationTransition,
  assertIntentTransition,
  assertOperationTransition,
  assertPlanRevisionTransition,
  canTransitionContextRequest,
  canTransitionCoordination,
  canTransitionIntent,
  canTransitionOperation,
  canTransitionPlanRevision,
  InvalidStateTransitionError,
} from "./state-machine.js";

describe("operation state machine", () => {
  it("accepts the asynchronous happy path and pause/resume paths", () => {
    expect(canTransitionOperation("accepted", "queued")).toBe(true);
    expect(canTransitionOperation("queued", "running")).toBe(true);
    expect(canTransitionOperation("running", "waiting_for_recipient")).toBe(true);
    expect(canTransitionOperation("waiting_for_recipient", "queued")).toBe(true);
    expect(canTransitionOperation("running", "input_required")).toBe(true);
    expect(canTransitionOperation("input_required", "queued")).toBe(true);
    expect(canTransitionOperation("running", "completed")).toBe(true);
  });

  it("keeps every terminal state terminal", () => {
    for (const state of ["completed", "failed", "cancelled", "expired", "escalated"] as const) {
      expect(canTransitionOperation(state, "queued"), state).toBe(false);
    }
  });

  it("throws a stable INVALID_STATE error for illegal transitions", () => {
    expect(() => assertOperationTransition("accepted", "completed")).toThrowError(
      InvalidStateTransitionError,
    );
    try {
      assertOperationTransition("accepted", "completed");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_STATE", machine: "operation" });
    }
  });
});

describe("coordination state machine", () => {
  it("requires status, proposal, and approvals before activation", () => {
    expect(canTransitionCoordination("detected", "status_pending")).toBe(true);
    expect(canTransitionCoordination("status_pending", "proposal_ready")).toBe(true);
    expect(canTransitionCoordination("proposal_ready", "awaiting_approvals")).toBe(true);
    expect(canTransitionCoordination("awaiting_approvals", "active")).toBe(true);
    expect(canTransitionCoordination("detected", "active")).toBe(false);
    expect(() => assertCoordinationTransition("detected", "active")).toThrow();
  });
});

describe("context state machine", () => {
  it("requires approval, generation, validation, and delivery in order", () => {
    expect(canTransitionContextRequest("requested", "approved")).toBe(true);
    expect(canTransitionContextRequest("approved", "generating")).toBe(true);
    expect(canTransitionContextRequest("generating", "validated")).toBe(true);
    expect(canTransitionContextRequest("validated", "delivered")).toBe(true);
    expect(canTransitionContextRequest("requested", "delivered")).toBe(false);
    expect(() => assertContextRequestTransition("denied", "approved")).toThrow();
  });
});

describe("plan revision and intent state machines", () => {
  it("requires approval before applying a revision", () => {
    expect(canTransitionPlanRevision("proposed", "approved")).toBe(true);
    expect(canTransitionPlanRevision("approved", "applied")).toBe(true);
    expect(canTransitionPlanRevision("proposed", "applied")).toBe(false);
    expect(() => assertPlanRevisionTransition("rejected", "approved")).toThrow();
  });

  it("pauses an implementing intent for context or replan and keeps completion terminal", () => {
    expect(canTransitionIntent("implementing", "awaiting_context")).toBe(true);
    expect(canTransitionIntent("implementing", "awaiting_replan")).toBe(true);
    expect(canTransitionIntent("awaiting_replan", "implementing")).toBe(true);
    expect(canTransitionIntent("completed", "implementing")).toBe(false);
    expect(() => assertIntentTransition("completed", "implementing")).toThrow();
  });
});
