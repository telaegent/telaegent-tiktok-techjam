import type {
  ContextRequestState,
  CoordinationState,
  IntentState,
  OperationState,
  PlanRevisionState,
} from "./types.js";

export class InvalidStateTransitionError extends Error {
  readonly code = "INVALID_STATE" as const;

  constructor(
    public readonly machine: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal ${machine} transition: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

export const OPERATION_TRANSITIONS = {
  accepted: ["queued", "waiting_for_recipient", "input_required", "failed"],
  queued: ["running", "cancelled", "failed"],
  running: [
    "completed",
    "input_required",
    "waiting_for_recipient",
    "failed",
    "cancelled",
    "escalated",
  ],
  waiting_for_recipient: ["queued", "expired", "cancelled", "escalated"],
  input_required: ["queued", "expired", "cancelled", "escalated"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
  escalated: [],
} as const satisfies Record<OperationState, readonly OperationState[]>;

export const COORDINATION_TRANSITIONS = {
  detected: ["status_pending"],
  status_pending: ["proposal_ready", "escalated"],
  proposal_ready: ["awaiting_approvals"],
  awaiting_approvals: ["active", "rejected", "expired"],
  active: ["completed", "escalated"],
  rejected: [],
  escalated: [],
  expired: [],
  completed: [],
} as const satisfies Record<CoordinationState, readonly CoordinationState[]>;

export const CONTEXT_REQUEST_TRANSITIONS = {
  requested: ["approved", "denied", "expired"],
  approved: ["generating", "expired"],
  generating: ["validated", "rejected", "expired"],
  validated: ["delivered", "expired"],
  delivered: ["expired"],
  denied: [],
  rejected: [],
  expired: [],
} as const satisfies Record<ContextRequestState, readonly ContextRequestState[]>;

export const PLAN_REVISION_TRANSITIONS = {
  proposed: ["approved", "rejected"],
  approved: ["applied"],
  rejected: [],
  applied: [],
} as const satisfies Record<PlanRevisionState, readonly PlanRevisionState[]>;

export const INTENT_TRANSITIONS = {
  planning: ["active", "coordination_required", "failed", "cancelled"],
  active: [
    "coordination_required",
    "implementing",
    "awaiting_context",
    "awaiting_replan",
    "completed",
    "failed",
    "cancelled",
  ],
  coordination_required: ["active", "implementing", "failed", "cancelled"],
  implementing: ["awaiting_context", "awaiting_replan", "completed", "failed", "cancelled"],
  awaiting_context: ["implementing", "failed", "cancelled"],
  awaiting_replan: ["implementing", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<IntentState, readonly IntentState[]>;

function includesState<TState extends string>(
  transitions: Record<TState, readonly TState[]>,
  from: TState,
  to: TState,
): boolean {
  return transitions[from].includes(to);
}

function assertState<TState extends string>(
  machine: string,
  transitions: Record<TState, readonly TState[]>,
  from: TState,
  to: TState,
): void {
  if (!includesState(transitions, from, to)) {
    throw new InvalidStateTransitionError(machine, from, to);
  }
}

export const canTransitionOperation = (from: OperationState, to: OperationState): boolean =>
  includesState(OPERATION_TRANSITIONS, from, to);
export const assertOperationTransition = (from: OperationState, to: OperationState): void =>
  assertState("operation", OPERATION_TRANSITIONS, from, to);

export const canTransitionCoordination = (
  from: CoordinationState,
  to: CoordinationState,
): boolean => includesState(COORDINATION_TRANSITIONS, from, to);
export const assertCoordinationTransition = (
  from: CoordinationState,
  to: CoordinationState,
): void => assertState("coordination", COORDINATION_TRANSITIONS, from, to);

export const canTransitionContextRequest = (
  from: ContextRequestState,
  to: ContextRequestState,
): boolean => includesState(CONTEXT_REQUEST_TRANSITIONS, from, to);
export const assertContextRequestTransition = (
  from: ContextRequestState,
  to: ContextRequestState,
): void => assertState("context", CONTEXT_REQUEST_TRANSITIONS, from, to);

export const canTransitionPlanRevision = (
  from: PlanRevisionState,
  to: PlanRevisionState,
): boolean => includesState(PLAN_REVISION_TRANSITIONS, from, to);
export const assertPlanRevisionTransition = (
  from: PlanRevisionState,
  to: PlanRevisionState,
): void => assertState("plan revision", PLAN_REVISION_TRANSITIONS, from, to);

export const canTransitionIntent = (from: IntentState, to: IntentState): boolean =>
  includesState(INTENT_TRANSITIONS, from, to);
export const assertIntentTransition = (from: IntentState, to: IntentState): void =>
  assertState("intent", INTENT_TRANSITIONS, from, to);
