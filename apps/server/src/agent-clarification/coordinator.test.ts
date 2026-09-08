/**
 * Coordinator tests for the task-scoped clarification loop.
 *
 * The coordinator is the only place that decides whether a task may exist at
 * all, which participant a dialogue job is labelled for, and what survives from
 * a model-authored dialogue result into a persisted row. None of those may
 * depend on the model being cooperative, so every fake here is deliberately
 * obedient: if a property still holds, it holds because the deterministic layer
 * enforced it and not because the fake refused to misbehave.
 */

import { describe, expect, it, vi } from "vitest";

import type {
  CollaborationTaskRepository,
  OpenCollaborationTaskInput,
} from "../authorization/collaboration-tasks.js";
import type { AuthorizedProtocolTurnService } from "../telagent/protocol/authorized-turn-service.js";
import {
  hashClarificationText,
  type ClarificationDialogueOutput,
  type PeerClarification,
} from "./contract.js";
import type {
  AgentClarificationContext,
  AgentClarificationContextLoader,
} from "./context-loader.js";
import {
  AgentClarificationCoordinator,
  type AgentClarificationDraftContext,
} from "./coordinator.js";
import type {
  AgentClarificationRepository,
  AgentClarificationTask,
  AgentClarificationTransition,
} from "./repository.js";

const REPOSITORY_ID = "1345851083";
const TASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORIGIN_MESSAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REQUESTER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RESPONDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const STEP_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const COUNTER_STEP_ID = "10101010-1010-4010-8010-101010101010";
/** In the approved capsule the loader hands back. */
const SHARED_MESSAGE_ID = "20202020-2020-4020-8020-202020202020";
/** Never in it: an id the model invented or copied from a private turn. */
const UNAPPROVED_MESSAGE_ID = "30303030-3030-4030-8030-303030303030";

function draft(
  overrides: Partial<AgentClarificationDraftContext> = {},
): AgentClarificationDraftContext {
  return {
    incomingMessageId: ORIGIN_MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    githubRepositoryId: REPOSITORY_ID,
    ownerUserId: RESPONDER_ID,
    ...overrides,
  };
}

/**
 * A task mid-dialogue: one question is outstanding and is addressed to whoever
 * `expectedUserId` names, because the prompt builder refuses to render a turn
 * for a participant the pending step was not asked of.
 */
function task(overrides: Partial<AgentClarificationTask> = {}): AgentClarificationTask {
  const merged: AgentClarificationTask = {
    taskId: TASK_ID,
    originSharedMessageId: ORIGIN_MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    githubRepositoryId: REPOSITORY_ID,
    requesterUserId: REQUESTER_ID,
    responderUserId: RESPONDER_ID,
    requesterProvider: "codex",
    requesterModel: null,
    responderProvider: "claude",
    responderModel: null,
    state: "dialogue_running",
    questionsUsed: 1,
    followUpRounds: 0,
    version: 3,
    expectedUserId: REQUESTER_ID,
    expectedLane: "clarification_dialogue",
    currentStepId: STEP_ID,
    expiresAt: "2999-01-01T00:00:00.000Z",
    steps: [],
    ...overrides,
  };
  if (overrides.steps || !merged.currentStepId || !merged.expectedUserId) {
    return merged;
  }
  const askedTo = merged.expectedUserId;
  return {
    ...merged,
    steps: [
      {
        stepId: merged.currentStepId,
        parentStepId: null,
        sequence: 1,
        askedByUserId:
          askedTo === merged.requesterUserId
            ? merged.responderUserId
            : merged.requesterUserId,
        askedToUserId: askedTo,
        question: "Which staging database?",
        answer: null,
        status: "pending",
        reasonCode: "ambiguity",
        sharedBasisMessageIds: [SHARED_MESSAGE_ID],
        contentHash: hashClarificationText("Which staging database?"),
        answerHash: null,
        humanRequiredReason: null,
        createdAt: "2026-09-08T00:00:01.000Z",
        resolvedAt: null,
      },
    ],
  };
}

function approvedContext(): AgentClarificationContext {
  return {
    taskId: TASK_ID,
    requesterName: "Mark",
    responderName: "Henry",
    sharedHistory: [
      {
        messageId: SHARED_MESSAGE_ID,
        authorUserId: REQUESTER_ID,
        authorName: "Mark",
        text: "Can you point the migration at staging before Friday?",
        sentAt: "2026-09-08T00:00:00.000Z",
      },
    ],
  };
}

function dialogueOutput(
  overrides: Partial<ClarificationDialogueOutput> = {},
): ClarificationDialogueOutput {
  return {
    outcome: "answered",
    replyToStepId: STEP_ID,
    answer: "The replica-backed one.",
    counterQuestion: null,
    privateExplanation: "Answered from the shared message.",
    sharedBasisMessageIds: [SHARED_MESSAGE_ID],
    humanRequiredReason: null,
    riskFlags: [],
    ...overrides,
  };
}

type BeginQuestionInput = Parameters<
  AgentClarificationRepository["beginQuestion"]
>[0];
type RecordDialogueInput = Parameters<
  AgentClarificationRepository["recordDialogueResult"]
>[0];
type DialogueTurnInput = Parameters<
  AuthorizedProtocolTurnService["startClarificationDialogue"]
>[0];

interface Harness {
  coordinator: AgentClarificationCoordinator;
  opened: OpenCollaborationTaskInput[];
  begun: BeginQuestionInput[];
  recorded: RecordDialogueInput[];
  dispatched: DialogueTurnInput[];
  stopped: string[];
  contextLoads: string[];
  /** Every read of the task row, which is what a wait for a person must not spend. */
  loads: string[];
  reconciled: { updatedAt: string }[];
  sweepCount: () => number;
}

function harness(
  setup: Readonly<{
    capable?: (userId: string) => boolean;
    activateOutcome?: "active" | "consent_missing";
    openOutcome?: "opened" | "unavailable";
    beginOutcome?: AgentClarificationTransition;
    recordOutcome?: (input: RecordDialogueInput) => AgentClarificationTransition;
    context?: AgentClarificationContext | null;
    finalOutput?: unknown;
    initialTask?: AgentClarificationTask;
    /** What the person's answer does to the row the parked loop re-reads. */
    humanAnswerOutcome?: AgentClarificationTransition;
    humanWaitBackstopMs?: number;
    reconcileCount?: number;
    sweptCount?: number;
    revokeOutcome?:
      | { outcome: "revoked"; cancelledTaskIds: string[] }
      | { outcome: "unavailable" };
  }> = {},
): Harness {
  const opened: OpenCollaborationTaskInput[] = [];
  const begun: BeginQuestionInput[] = [];
  const recorded: RecordDialogueInput[] = [];
  const dispatched: DialogueTurnInput[] = [];
  const stopped: string[] = [];
  const contextLoads: string[] = [];
  const loads: string[] = [];
  const reconciled: { updatedAt: string }[] = [];
  let sweeps = 0;
  // Mutable, because the row a parked loop re-reads is the one the person's
  // answer just moved. A fake that could not move it could only test a loop
  // that never finishes waiting.
  let current = setup.initialTask ?? task();

  const tasks: CollaborationTaskRepository = {
    async openTask(input) {
      opened.push({ ...input });
      if (setup.openOutcome === "unavailable") return { outcome: "unavailable" };
      return {
        outcome: "opened",
        taskId: TASK_ID,
        conversationId: CONVERSATION_ID,
        githubRepositoryId: REPOSITORY_ID,
        requesterUserId: REQUESTER_ID,
        responderUserId: RESPONDER_ID,
        expiresAt: current.expiresAt,
      };
    },
    async endTask() {
      return { outcome: "already_ended" };
    },
  };

  const repository = {
    async grantOriginator() {
      return { outcome: "granted" as const };
    },
    async activate() {
      return setup.activateOutcome === "consent_missing"
        ? { outcome: "consent_missing" as const }
        : { outcome: "active" as const, task: current };
    },
    async load(input: { taskId: string; actorUserId: string }) {
      loads.push(input.taskId);
      return { outcome: "available" as const, task: current };
    },
    async list() {
      return [current];
    },
    async beginQuestion(input: BeginQuestionInput) {
      begun.push({ ...input });
      return (
        setup.beginOutcome ?? { outcome: "route_dialogue" as const, task: current }
      );
    },
    async recordDialogueResult(input: RecordDialogueInput) {
      recorded.push({ ...input });
      return (
        setup.recordOutcome?.(input) ?? {
          outcome: "resume_recipient" as const,
          task: task({
            state: "recipient_running",
            expectedLane: "private_work",
            expectedUserId: RESPONDER_ID,
            currentStepId: null,
          }),
        }
      );
    },
    async continueWithHumanAnswer() {
      const outcome = setup.humanAnswerOutcome ?? { outcome: "stale" as const };
      if ("task" in outcome) current = outcome.task;
      return outcome;
    },
    async stop(input: { taskId: string; actorUserId: string }) {
      stopped.push(input.taskId);
      // The real one clears the routing state as it goes terminal, which is
      // what a loop parked on this task re-reads once the stop wakes it.
      current = {
        ...current,
        state: "cancelled",
        expectedLane: null,
        expectedUserId: null,
        currentStepId: null,
      };
      return { outcome: "stopped" as const };
    },
    async complete() {
      return { outcome: "stopped" as const };
    },
    async reconcileDriving(input: { updatedAt: string }) {
      reconciled.push({ ...input });
      return setup.reconcileCount ?? 0;
    },
    async sweepExpiredPayloads() {
      sweeps += 1;
      return setup.sweptCount ?? 0;
    },
    async revokeOriginator() {
      const outcome = setup.revokeOutcome ?? { outcome: "unavailable" as const };
      // The real RPC cancels whatever the withdrawn consent was feeding, and
      // the loop parked on that task re-reads the row the moment it is woken.
      if (outcome.outcome === "revoked" && outcome.cancelledTaskIds.length > 0) {
        current = {
          ...current,
          state: "cancelled",
          expectedLane: null,
          expectedUserId: null,
          currentStepId: null,
        };
      }
      return outcome;
    },
  } satisfies AgentClarificationRepository;

  const context: AgentClarificationContextLoader = {
    async load(input) {
      contextLoads.push(input.actorUserId);
      return setup.context === undefined ? approvedContext() : setup.context;
    },
  };

  const runtime = {
    async startClarificationDialogue(input: DialogueTurnInput) {
      dispatched.push(input);
      // The real starter revalidates the reservation before dispatching, so a
      // fake that skipped it would quietly test a weaker orchestration.
      await input.revalidate();
      return {
        turnId: "turn-1",
        streamId: "stream-1",
        initialState: "queued" as const,
        completion: Promise.resolve({
          provider: "claude" as const,
          final:
            setup.finalOutput === undefined ? dialogueOutput() : setup.finalOutput,
          changedFiles: [],
          exitCode: 0,
          durationMs: 5,
        }),
      };
    },
  } as unknown as AuthorizedProtocolTurnService;

  let nextId = 0;
  const ids = [STEP_ID, COUNTER_STEP_ID];

  const coordinator = new AgentClarificationCoordinator(
    tasks,
    repository,
    context,
    runtime,
    {
      supportsCapabilities: (userId) => setup.capable?.(userId) ?? true,
      createId: () => ids[nextId++] ?? `generated-${nextId}`,
      humanWaitBackstopMs: setup.humanWaitBackstopMs ?? 100,
    },
  );

  return {
    coordinator,
    opened,
    begun,
    recorded,
    dispatched,
    stopped,
    contextLoads,
    loads,
    reconciled,
    sweepCount: () => sweeps,
  };
}

describe("plan section 7.1 capability gate", () => {
  it("refuses to open a task for a connector that never advertised v2", () => {
    // This is the whole compatibility story. The connector job schema is a
    // strict object, so a version-2 envelope field reaching a version-1
    // connector is a hard parse failure on the collaborator's machine. Never
    // producing a task session is what keeps that field from being built.
    const { coordinator, opened } = harness({ capable: () => false });

    return Promise.all([
      coordinator
        .activateForRecipient(draft(), { provider: "claude" })
        .then((result) => expect(result).toBeNull()),
      coordinator
        .loadForRecipient(draft())
        .then((result) => expect(result).toBeNull()),
    ]).then(() => {
      // Not merely a null return: the task was never opened, so an incapable
      // connector leaves no row and no budget spent behind it either.
      expect(opened).toEqual([]);
    });
  });

  it("asks about the recipient, who is the participant that receives the job", async () => {
    const asked: Array<[string, string]> = [];
    const { coordinator } = harness({
      capable: (userId) => {
        asked.push([userId, REPOSITORY_ID]);
        return true;
      },
    });

    await coordinator.activateForRecipient(draft(), { provider: "claude" });

    expect(asked).toEqual([[RESPONDER_ID, REPOSITORY_ID]]);
  });

  it("opens and activates the task once the binding is capable", async () => {
    const { coordinator, opened } = harness();

    const activated = await coordinator.activateForRecipient(draft(), {
      provider: "claude",
      model: "sonnet",
    });

    expect(activated?.taskId).toBe(TASK_ID);
    expect(opened).toEqual([
      {
        taskId: STEP_ID,
        originSharedMessageId: ORIGIN_MESSAGE_ID,
        responderUserId: RESPONDER_ID,
      },
    ]);
  });

  it("never opens a task for a draft with no incoming message", async () => {
    const { coordinator, opened } = harness();

    expect(
      await coordinator.activateForRecipient(draft({ incomingMessageId: null }), {
        provider: "claude",
      }),
    ).toBeNull();
    expect(await coordinator.loadForRecipient(draft({ incomingMessageId: null }))).toBeNull();
    expect(opened).toEqual([]);
  });

  it("stops the task when the peer loses the capability mid-loop", async () => {
    // The requester's connector is the one being dispatched to here, and it
    // went away between activation and dispatch.
    const { coordinator, dispatched, stopped } = harness({
      capable: (userId) => userId !== REQUESTER_ID,
    });

    const outcome = await coordinator.exchange(task(), {
      question: "Which staging database?",
      reasonCode: "ambiguity",
      sharedBasisMessageIds: [SHARED_MESSAGE_ID],
    });

    expect(outcome).toEqual({ outcome: "not_enabled" });
    expect(dispatched).toEqual([]);
    expect(stopped).toEqual([TASK_ID]);
  });
});

describe("shared basis narrowing", () => {
  const question: PeerClarification = {
    question: "Which staging database?",
    reasonCode: "ambiguity",
    sharedBasisMessageIds: [SHARED_MESSAGE_ID, UNAPPROVED_MESSAGE_ID],
  };

  it("drops unapproved ids before the question is persisted", async () => {
    const { coordinator, begun } = harness();

    await coordinator.exchange(task(), question);

    expect(begun).toHaveLength(1);
    expect(begun[0]?.sharedBasisMessageIds).toEqual([SHARED_MESSAGE_ID]);
    expect(begun[0]?.reasonCode).toBe("ambiguity");
    // Narrowing the hints must not rewrite the question the peer will read.
    expect(begun[0]?.question).toBe(question.question);
  });

  it("persists a plan section 6 normalized hash, not a raw digest", async () => {
    const { coordinator, begun } = harness();

    await coordinator.exchange(task(), {
      ...question,
      question: "  Which staging\r\ndatabase?  ",
    });

    expect(begun[0]?.contentHash).toBe(
      hashClarificationText("Which staging\ndatabase?"),
    );
  });

  it("narrows a dialogue result at both the turn and counter-question level", async () => {
    const { coordinator, recorded } = harness({
      finalOutput: dialogueOutput({
        outcome: "counter_question",
        answer: null,
        sharedBasisMessageIds: [UNAPPROVED_MESSAGE_ID, SHARED_MESSAGE_ID],
        counterQuestion: {
          question: "Do you mean the read replica?",
          reasonCode: "missing_intent",
          sharedBasisMessageIds: [UNAPPROVED_MESSAGE_ID],
        },
      }),
    });

    await coordinator.exchange(task(), question);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.output.sharedBasisMessageIds).toEqual([SHARED_MESSAGE_ID]);
    // A nested object is the easy one to forget, and it is the one the peer
    // actually sees next.
    expect(recorded[0]?.output.counterQuestion?.sharedBasisMessageIds).toEqual([]);
    // A counter-question's own text is what the next hash is taken over.
    expect(recorded[0]?.contentHash).toBe(
      hashClarificationText("Do you mean the read replica?"),
    );
  });

  it("still persists when the approved capsule cannot be loaded for the asker", async () => {
    // Losing the capsule must not become an implicit widening: every hint is
    // dropped rather than passed through unchecked.
    const { coordinator, begun } = harness({ context: null });

    await coordinator.exchange(task(), question);

    expect(begun[0]?.sharedBasisMessageIds).toEqual([]);
  });
});

describe("dialogue dispatch", () => {
  const question: PeerClarification = {
    question: "Which staging database?",
    reasonCode: "ambiguity",
    sharedBasisMessageIds: [SHARED_MESSAGE_ID],
  };

  it("derives participantRole and the peer from the task", async () => {
    const { coordinator, dispatched } = harness();

    await coordinator.exchange(task(), question);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.participantRole).toBe("requester");
    expect(dispatched[0]?.peerUserId).toBe(RESPONDER_ID);
    expect(dispatched[0]?.authorization.authenticatedUserId).toBe(REQUESTER_ID);
    expect(dispatched[0]?.stepId).toBe(STEP_ID);
  });

  it("labels the other direction from the same task, not from the output", async () => {
    const { coordinator, dispatched } = harness({
      initialTask: task({ expectedUserId: RESPONDER_ID }),
    });

    await coordinator.exchange(task({ expectedUserId: RESPONDER_ID }), question);

    expect(dispatched[0]?.participantRole).toBe("responder");
    expect(dispatched[0]?.peerUserId).toBe(REQUESTER_ID);
  });

  it("uses the acting participant's own provider choice", async () => {
    const { coordinator, dispatched } = harness({
      initialTask: task({ requesterProvider: "codex", requesterModel: "gpt-5" }),
    });

    await coordinator.exchange(
      task({ requesterProvider: "codex", requesterModel: "gpt-5" }),
      question,
    );

    expect(dispatched[0]?.provider).toBe("codex");
    expect(dispatched[0]?.model).toBe("gpt-5");
  });

  it("loads the approved capsule for the participant being dispatched", async () => {
    const { coordinator, contextLoads } = harness();

    await coordinator.exchange(task(), question);

    // The asker's capsule narrows the question; the answerer's capsule is the
    // one the answering agent is allowed to read. They are not interchangeable.
    expect(contextLoads).toEqual([RESPONDER_ID, REQUESTER_ID]);
  });
});

describe("dialogue results the model got wrong", () => {
  const question: PeerClarification = {
    question: "Which staging database?",
    reasonCode: "ambiguity",
    sharedBasisMessageIds: [SHARED_MESSAGE_ID],
  };

  it("stops the task when the reply names a different parent step", async () => {
    // `replyToStepId` is the only proof the answer belongs to the question that
    // was dispatched. A mismatch means the model answered something else.
    const { coordinator, recorded, stopped } = harness({
      finalOutput: dialogueOutput({ replyToStepId: COUNTER_STEP_ID }),
    });

    expect(await coordinator.exchange(task(), question)).toEqual({
      outcome: "not_enabled",
    });
    expect(recorded).toEqual([]);
    expect(stopped).toEqual([TASK_ID]);
  });

  it("stops the task when the reply does not parse as a dialogue output", async () => {
    const { coordinator, recorded, stopped } = harness({
      finalOutput: {
        outcome: "answered",
        replyToStepId: STEP_ID,
        answer: "here you go",
        counterQuestion: null,
        privateExplanation: "",
        sharedBasisMessageIds: [],
        humanRequiredReason: null,
        riskFlags: [],
        sendCandidate: "ship it",
      },
    });

    expect(await coordinator.exchange(task(), question)).toEqual({
      outcome: "not_enabled",
    });
    expect(recorded).toEqual([]);
    expect(stopped).toEqual([TASK_ID]);
  });

  it("reports exhaustion from the database without dispatching a turn", async () => {
    const { coordinator, dispatched } = harness({
      beginOutcome: { outcome: "exhausted" },
    });

    expect(await coordinator.exchange(task(), question)).toEqual({
      outcome: "exhausted",
    });
    // The two-question cap is the database's to enforce, and the coordinator
    // must not spend a provider turn arguing with it.
    expect(dispatched).toEqual([]);
  });

  it("returns the recipient to its private_work lane once the answer lands", async () => {
    const { coordinator } = harness();

    const outcome = await coordinator.exchange(task(), question);

    expect(outcome.outcome).toBe("resolved");
    expect(
      outcome.outcome === "resolved" ? outcome.task.expectedLane : null,
    ).toBe("private_work");
  });

  it("cancels rather than dispatching once the task lifetime has passed", async () => {
    const expired = task({ expiresAt: "2020-01-01T00:00:00.000Z" });
    const { coordinator, dispatched } = harness({ initialTask: expired });

    expect(await coordinator.exchange(expired, question)).toEqual({
      outcome: "cancelled",
    });
    expect(dispatched).toEqual([]);
  });
});

describe("waiting on a person", () => {
  const question: PeerClarification = {
    question: "Which staging database?",
    reasonCode: "ambiguity",
    sharedBasisMessageIds: [SHARED_MESSAGE_ID],
  };
  const parked = task({
    state: "human_required",
    expectedLane: "human",
    expectedUserId: REQUESTER_ID,
    currentStepId: STEP_ID,
  });
  const resumed = task({
    state: "recipient_running",
    expectedLane: "private_work",
    expectedUserId: RESPONDER_ID,
    currentStepId: null,
    version: 4,
  });

  it("parks until the answer arrives rather than re-reading the task on a timer", async () => {
    const { coordinator, recorded, loads } = harness({
      recordOutcome: () => ({ outcome: "human_required", task: parked }),
      humanAnswerOutcome: { outcome: "resume_recipient", task: resumed },
      // Ten minutes. Anything that finishes inside this test finished because
      // the answer woke it, not because the backstop fired.
      humanWaitBackstopMs: 600_000,
    });

    const running = coordinator.exchange(task(), question);
    // A timer tick, so every microtask the drive loop still owed has run and
    // the wait is registered. An answer delivered before that wakes nobody.
    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    const readsBeforeTheAnswer = loads.length;

    expect(
      await coordinator.continueWithHumanAnswer({
        taskId: TASK_ID,
        actorUserId: REQUESTER_ID,
        currentStepId: STEP_ID,
        answer: "The replica-backed one.",
        expectedVersion: parked.version,
      }),
    ).toBe("continued");

    expect(await running).toEqual({ outcome: "resolved", task: resumed });
    // One read, at the end of the wait. The 750ms poll this replaced spent one
    // every 750ms for as long as the person took to answer, which the task
    // lifetime allows to be a full hour.
    expect(loads.length - readsBeforeTheAnswer).toBe(1);
  });

  it("lets go of the wait when the task is stopped underneath it", async () => {
    const { coordinator, recorded } = harness({
      recordOutcome: () => ({ outcome: "human_required", task: parked }),
      humanWaitBackstopMs: 600_000,
    });

    const running = coordinator.exchange(task(), question);
    await vi.waitFor(() => expect(recorded).toHaveLength(1));

    // Either participant may end the exchange while the other is still being
    // asked. Without the wake here the loop would sit on a question its task
    // no longer has until the backstop noticed.
    expect(await coordinator.stop(TASK_ID, RESPONDER_ID)).toBe(true);
    expect(await running).toEqual({ outcome: "cancelled" });
  });
});

describe("restart recovery", () => {
  it("cancels the exchanges whose driver died, stamped with this process's clock", async () => {
    const { coordinator, reconciled } = harness({ reconcileCount: 3 });

    expect(await coordinator.reconcileAbandoned()).toBe(3);
    // Deliberately unscoped: the process that could name the exchanges it was
    // driving is the one that died, so there is nothing to name them by.
    expect(reconciled).toHaveLength(1);
    expect(Date.parse(reconciled[0]?.updatedAt ?? "")).not.toBeNaN();
  });

  it("reports nothing to recover as nothing, not as an error", async () => {
    const { coordinator } = harness();

    expect(await coordinator.reconcileAbandoned()).toBe(0);
  });
});

describe("withdrawing consent", () => {
  const question: PeerClarification = {
    question: "Which staging database?",
    reasonCode: "ambiguity",
    sharedBasisMessageIds: [SHARED_MESSAGE_ID],
  };
  const parked = task({
    state: "human_required",
    expectedLane: "human",
    expectedUserId: REQUESTER_ID,
    currentStepId: STEP_ID,
  });

  it("releases the exchange the withdrawn consent was feeding", async () => {
    // The window this covers is the one before any task exists, but consent can
    // also be taken back mid-exchange -- and then the question a person is
    // being shown has become unanswerable. Waking the parked loop is what turns
    // that from a 30-second backstop wait into an immediate end.
    const { coordinator, recorded } = harness({
      recordOutcome: () => ({ outcome: "human_required", task: parked }),
      revokeOutcome: { outcome: "revoked", cancelledTaskIds: [TASK_ID] },
      humanWaitBackstopMs: 600_000,
    });

    const running = coordinator.exchange(task(), question);
    await vi.waitFor(() => expect(recorded).toHaveLength(1));

    expect(
      await coordinator.revokeOriginator({
        originSharedMessageId: SHARED_MESSAGE_ID,
        actorUserId: REQUESTER_ID,
      }),
    ).toBe(true);
    expect(await running).toEqual({ outcome: "cancelled" });
  });

  it("refuses a withdrawal that is not the grantor's to make", async () => {
    const { coordinator } = harness({ revokeOutcome: { outcome: "unavailable" } });

    expect(
      await coordinator.revokeOriginator({
        originSharedMessageId: SHARED_MESSAGE_ID,
        actorUserId: RESPONDER_ID,
      }),
    ).toBe(false);
  });
});

describe("retention", () => {
  it("deletes clarification text past its task lifetime on demand", async () => {
    // The caller is a timer, not a request. Opening a new exchange sweeps too,
    // but an exchange both people abandoned is never touched again -- so the
    // documented 60-minute deletion cannot depend on anyone opening anything.
    const { coordinator, sweepCount } = harness({ sweptCount: 4 });

    expect(await coordinator.sweepExpiredPayloads()).toBe(4);
    expect(sweepCount()).toBe(1);
  });
});
