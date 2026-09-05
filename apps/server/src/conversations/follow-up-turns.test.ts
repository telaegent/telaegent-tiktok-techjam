/**
 * The capability loop inside one turn (build plan 8.6).
 *
 * A recipient agent finishes holding questions about files on the other
 * person's machine. What has to happen next is a round: the questions travel,
 * whatever a human over there already allowed comes back, and the turn runs
 * again with those files in its prompt.
 *
 * It happens inside one settling because approved bytes travel in flight and
 * are never stored. If the loop spanned two requests, somebody else's file
 * would have to be kept somewhere in between - and there is nowhere it may be
 * kept.
 */

import { describe, expect, it, vi } from "vitest";

import type { PrivateDraftFollowUp } from "../capability/draft-follow-up.js";
import type { ConnectorResourceRequest } from "../connectors/resource-exchange.js";
import type { RecipientTurnOutput } from "../telagent/protocol/contract.js";
import type { StartAuthorizedProtocolTurnInput } from "../telagent/protocol/authorized-turn-service.js";
import { InMemoryConversationRepository } from "./in-memory-repository.js";
import {
  ConversationService,
  type ConversationAccessAuthorizer,
  type PrivateDraftTurnRuntime,
} from "./service.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const REPOSITORY = "1345851083";
const MESSAGE = "88888888-8888-4888-8888-888888888888";
const DRAFT = "22222222-2222-4222-8222-222222222222";
const RESOURCE = `resource_${"a".repeat(24)}`;

const ask: ConnectorResourceRequest = {
  kind: "hint",
  hint: "src/settings.ts",
  reason: "the answer depends on how the token is rotated",
};

function output(privateSummary: string): RecipientTurnOutput {
  return {
    state: "ready",
    privateSummary,
    sendCandidate: privateSummary,
    riskFlags: [],
    sourcePaths: [],
  };
}

function turn(
  privateSummary: string,
  resourceRequests?: readonly ConnectorResourceRequest[],
) {
  return {
    provider: "codex" as const,
    final: output(privateSummary),
    changedFiles: [],
    exitCode: 0,
    durationMs: 1,
    ...(resourceRequests ? { resourceRequests } : {}),
  };
}

function harness(
  turns: readonly ReturnType<typeof turn>[],
  followUp?: PrivateDraftFollowUp,
) {
  const access: ConversationAccessAuthorizer = { async authorize() {} };
  const remaining = [...turns];
  const starts: StartAuthorizedProtocolTurnInput[] = [];
  const runtime: PrivateDraftTurnRuntime = {
    async start(input) {
      starts.push(input as StartAuthorizedProtocolTurnInput);
      const next = remaining.shift() ?? turns[turns.length - 1];
      return {
        turnId: input.turnId ?? `turn-${String(starts.length)}`,
        streamId: "55555555-5555-4555-8555-555555555555",
        initialState: "queued" as const,
        completion: Promise.resolve(next) as never,
      };
    },
    async cancel() {
      return true;
    },
  };
  const repository = new InMemoryConversationRepository();
  const service = new ConversationService(repository, access, runtime, {
    now: () => new Date("2026-08-31T12:00:00.000Z"),
    createId: () => DRAFT,
    createTurnId: () => "44444444-4444-4444-8444-444444444444",
    ...(followUp ? { followUp } : {}),
  });
  return { service, repository, starts };
}

/**
 * A recipient draft is seeded straight into the record.
 *
 * Going through `createRecipientDraft` would mean staging a whole crossing
 * message first, and none of that is what these tests are about: they start
 * where a draft already exists and its agent is about to run.
 */
async function seedDraft(
  repository: InMemoryConversationRepository,
): Promise<void> {
  await repository.createDraft({
    draftId: DRAFT,
    conversationId: CONVERSATION,
    githubRepositoryId: REPOSITORY,
    ownerUserId: OWNER,
    provider: "codex",
    role: "recipient",
    roughMessage: null,
    incomingMessageId: MESSAGE,
    privateTurns: [],
    state: "created",
    turnId: null,
    privateMessage: null,
    sendCandidate: null,
    riskFlags: [],
    guardFindings: [],
    failure: null,
    createdAt: "2026-08-31T12:00:00.000Z",
    updatedAt: "2026-08-31T12:00:00.000Z",
    sentMessageId: null,
  });
}

describe("a turn that asks for files it cannot see", () => {
  it("runs again with what the other person's human allowed", async () => {
    const followUp: PrivateDraftFollowUp = {
      run: vi.fn(async () => [
        { resourceId: RESOURCE, content: "rotate();", truncated: false },
      ]),
      end: async () => undefined,
    };
    const { service, repository, starts } = harness(
      [turn("I need the settings file", [ask]), turn("Rotation happens hourly")],
      followUp,
    );

    await seedDraft(repository);
    await service.runDraft(OWNER, DRAFT);

    await expect
      .poll(() => service.getDraft(OWNER, DRAFT))
      .toMatchObject({ state: "ready", privateMessage: "Rotation happens hourly" });
    // The second turn is the same draft continuing, carrying the approved
    // files in its prompt and nothing else.
    expect(starts).toHaveLength(2);
    expect(starts[1]?.deliveredResources).toEqual([
      { resourceId: RESOURCE, content: "rotate();", truncated: false },
    ]);
    expect(followUp.run).toHaveBeenCalledWith(
      {
        incomingMessageId: MESSAGE,
        conversationId: CONVERSATION,
        githubRepositoryId: REPOSITORY,
        ownerUserId: OWNER,
      },
      [ask],
    );
  });

  it("answers with what it had when nothing came back", async () => {
    const followUp: PrivateDraftFollowUp = {
      run: async () => [],
      end: async () => undefined,
    };
    const { service, repository, starts } = harness(
      [turn("I asked and I am still waiting", [ask])],
      followUp,
    );

    await seedDraft(repository);
    await service.runDraft(OWNER, DRAFT);

    // The questions are with a human now. Waiting on a person inside a turn
    // would hold the draft open for as long as that person takes.
    await expect
      .poll(() => service.getDraft(OWNER, DRAFT))
      .toMatchObject({ state: "ready" });
    expect(starts).toHaveLength(1);
  });

  it("asks nobody anything where no loop is configured", async () => {
    const { service, repository, starts } = harness([turn("I need the settings file", [ask])]);

    await seedDraft(repository);
    await service.runDraft(OWNER, DRAFT);

    await expect
      .poll(() => service.getDraft(OWNER, DRAFT))
      .toMatchObject({ state: "ready" });
    expect(starts).toHaveLength(1);
  });

  it("stops after five rounds however long the agent keeps asking", async () => {
    const followUp: PrivateDraftFollowUp = {
      run: vi.fn(async () => [
        { resourceId: RESOURCE, content: "rotate();", truncated: false },
      ]),
      end: async () => undefined,
    };
    // Every turn asks again and every round delivers, which is the shape a
    // loop that cannot make progress has.
    const { service, repository, starts } = harness([turn("still asking", [ask])], followUp);

    await seedDraft(repository);
    await service.runDraft(OWNER, DRAFT);

    await expect
      .poll(() => service.getDraft(OWNER, DRAFT))
      .toMatchObject({ state: "ready" });
    // The first turn plus five rounds. The database holds the same bound on
    // the task itself; this is the copy that stops a runtime which never
    // reached it.
    expect(starts).toHaveLength(6);
    expect(followUp.run).toHaveBeenCalledTimes(5);
  });

  it("ends task-scoped authority after the recipient sends the final response", async () => {
    const end = vi.fn<NonNullable<PrivateDraftFollowUp["end"]>>(async () => undefined);
    const followUp: PrivateDraftFollowUp = { run: async () => [], end };
    const { service, repository } = harness([turn("Rotation happens hourly")], followUp);

    await seedDraft(repository);
    await service.runDraft(OWNER, DRAFT);
    await expect.poll(() => service.getDraft(OWNER, DRAFT)).toMatchObject({ state: "ready" });
    await service.sendDraft({
      authenticatedUserId: OWNER,
      draftId: DRAFT,
      idempotencyKey: "send-once",
    });

    expect(end).toHaveBeenCalledWith(
      expect.objectContaining({ incomingMessageId: MESSAGE, ownerUserId: OWNER }),
      "completed",
    );
  });

  it("ends task-scoped authority when the recipient cancels", async () => {
    const end = vi.fn<NonNullable<PrivateDraftFollowUp["end"]>>(async () => undefined);
    const followUp: PrivateDraftFollowUp = { run: async () => [], end };
    const { service, repository } = harness([turn("unused")], followUp);

    await seedDraft(repository);
    await service.cancelDraft(OWNER, DRAFT);

    expect(end).toHaveBeenCalledWith(
      expect.objectContaining({ incomingMessageId: MESSAGE, ownerUserId: OWNER }),
      "cancelled",
    );
  });
});

/**
 * Cancelling has to reach the round that is actually running.
 *
 * The draft keeps the turn identifier it claimed when it started, so an owner
 * sees one turn. Each follow-up round is a separate runtime turn with its own
 * identifier, and the coordinator only tracks the newest one as running.
 * Addressing the draft's original identifier therefore stopped nothing once a
 * second round had begun: the coordinator returned false and Cancel answered
 * 409 while the agent kept reading the repository.
 */
describe("cancelling a turn that is on a later round", () => {
  it("stops the round that is running, not the one that already finished", async () => {
    const cancelled: string[] = [];
    const starts: StartAuthorizedProtocolTurnInput[] = [];
    let releaseSecondRound: (() => void) | undefined;
    const secondRoundStarted = Promise.withResolvers<void>();

    const runtime: PrivateDraftTurnRuntime = {
      async start(input) {
        starts.push(input as StartAuthorizedProtocolTurnInput);
        const round = starts.length;
        const turnId = input.turnId ?? `turn-${String(round)}`;
        if (round === 1) {
          return {
            turnId,
            streamId: "55555555-5555-4555-8555-555555555555",
            initialState: "queued" as const,
            completion: Promise.resolve(
              turn("I need the settings file", [ask]),
            ) as never,
          };
        }
        // The second round hangs, which is the state an owner cancels from.
        secondRoundStarted.resolve();
        return {
          turnId,
          streamId: "55555555-5555-4555-8555-555555555555",
          initialState: "queued" as const,
          completion: new Promise<void>((resolve) => {
            releaseSecondRound = resolve;
          }).then(() => turn("never delivered")) as never,
        };
      },
      async cancel(input) {
        cancelled.push(input.turnId);
        return true;
      },
    };

    const repository = new InMemoryConversationRepository();
    const service = new ConversationService(
      repository,
      { async authorize() {} },
      runtime,
      {
        now: () => new Date("2026-08-31T12:00:00.000Z"),
        createId: () => DRAFT,
        createTurnId: () => "44444444-4444-4444-8444-444444444444",
        followUp: {
          run: async () => [
            { resourceId: RESOURCE, content: "rotate();", truncated: false },
          ],
          end: async () => undefined,
        },
      },
    );

    await seedDraft(repository);
    await service.runDraft(OWNER, DRAFT);
    await secondRoundStarted.promise;

    await service.cancelDraft(OWNER, DRAFT);

    // The second round's identifier, not the identifier the draft still holds.
    expect(starts).toHaveLength(2);
    expect(cancelled).toEqual(["turn-2"]);
    expect(cancelled).not.toContain("44444444-4444-4444-8444-444444444444");

    releaseSecondRound?.();
  });
});

/**
 * Recovering drafts a restart left running.
 *
 * Draft state is durable; the runtime advancing it is not. The coordinator's
 * turn map, the relay's registrations and the in-flight completion all die with
 * the process while `agent_working` rows survive, and such a draft is
 * unreachable through the normal API: running requires `created`, and
 * cancelling has to name a turn no coordinator still tracks.
 */
describe("a draft left running by a restart", () => {
  it("is failed retryably so its owner can run it again", async () => {
    const repository = new InMemoryConversationRepository();
    let releaseTurn: (() => void) | undefined;
    const runtime: PrivateDraftTurnRuntime = {
      async start(input) {
        return {
          turnId: input.turnId ?? "turn-1",
          streamId: "55555555-5555-4555-8555-555555555555",
          initialState: "queued" as const,
          completion: new Promise<void>((resolve) => {
            releaseTurn = resolve;
          }).then(() => turn("never delivered")) as never,
        };
      },
      async cancel() {
        return true;
      },
    };
    const service = new ConversationService(
      repository,
      { async authorize() {} },
      runtime,
      {
        now: () => new Date("2026-08-31T12:00:00.000Z"),
        createId: () => DRAFT,
        createTurnId: () => "44444444-4444-4444-8444-444444444444",
      },
    );

    await seedDraft(repository);
    await service.runDraft(OWNER, DRAFT);
    await expect(service.getDraft(OWNER, DRAFT)).resolves.toMatchObject({
      state: "agent_working",
    });

    // The process the turn was running in goes away. A fresh service over the
    // same durable rows is what comes back.
    const restarted = new ConversationService(
      repository,
      { async authorize() {} },
      runtime,
      { now: () => new Date("2026-08-31T12:05:00.000Z") },
    );
    await expect(restarted.reconcileRunningDrafts()).resolves.toBe(1);

    const recovered = await restarted.getDraft(OWNER, DRAFT);
    expect(recovered).toMatchObject({
      state: "runtime_failed",
      // Retryable is what makes the draft actionable again: the browser only
      // offers Retry on a failed draft whose failure is retryable.
      failure: { code: "RUNTIME_UNAVAILABLE", retryable: true },
    });
    // A candidate from a turn that never finished was never approved.
    expect(recovered.sendCandidate).toBeNull();

    releaseTurn?.();
  });

  it("leaves drafts alone that were not running", async () => {
    const repository = new InMemoryConversationRepository();
    const service = new ConversationService(
      repository,
      { async authorize() {} },
      {
        async start() {
          throw new Error("not started");
        },
        async cancel() {
          return true;
        },
      },
      { now: () => new Date("2026-08-31T12:00:00.000Z"), createId: () => DRAFT },
    );

    await seedDraft(repository);

    // A draft sitting in `created` is not stranded and must not be failed.
    await expect(service.reconcileRunningDrafts()).resolves.toBe(0);
    await expect(service.getDraft(OWNER, DRAFT)).resolves.toMatchObject({
      state: "created",
      failure: null,
    });
  });
});
