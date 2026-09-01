/**
 * The seam between a private draft and the capability loop (build plan 8).
 *
 * What it has to get right is provenance. The draft says who is asking and
 * which message it is answering; everything else - which repository, which
 * conversation, whose files - comes back from the record of the task that
 * message opened. A draft that named a repository could name someone else's.
 */

import { describe, expect, it, vi } from "vitest";

import type { CollaborationTaskRepository } from "../authorization/collaboration-tasks.js";
import type { ConnectorResourceRequest } from "../connectors/resource-exchange.js";
import { DraftFollowUpService, type FollowUpDraftContext } from "./draft-follow-up.js";
import type {
  CapabilityFollowUpCoordinator,
  CapabilityFollowUpOutcome,
} from "./follow-up-coordinator.js";

const taskId = "20000000-0000-4000-8000-000000000001";
const messageId = "80000000-0000-4000-8000-000000000001";
const conversationId = "30000000-0000-4000-8000-000000000001";
const requesterId = "10000000-0000-4000-8000-000000000001";
const responderId = "10000000-0000-4000-8000-000000000002";
const resourceId = `resource_${"a".repeat(24)}`;

const draft: FollowUpDraftContext = {
  incomingMessageId: messageId,
  conversationId: "conversation-the-draft-thinks-it-is-in",
  githubRepositoryId: "999",
  ownerUserId: responderId,
};

const ask: ConnectorResourceRequest = {
  kind: "hint",
  hint: "src/settings.ts",
  reason: "the answer depends on how the token is rotated",
};

const opened = {
  outcome: "opened",
  taskId,
  conversationId,
  githubRepositoryId: "1345851084",
  requesterUserId: requesterId,
  responderUserId: responderId,
  expiresAt: "2026-08-31T10:40:00.000Z",
} as const;

const completed: CapabilityFollowUpOutcome = {
  outcome: "completed",
  round: 1,
  delivered: [
    { resourceId, content: "rotate();", truncated: false, byteLength: 9 },
  ],
  queued: [],
  pendingWithoutCandidate: 0,
  refused: 0,
  spentGrantIds: [],
};

function build(parts: {
  openTask?: CollaborationTaskRepository["openTask"];
  endTask?: CollaborationTaskRepository["endTask"];
  runRound?: CapabilityFollowUpCoordinator["runRound"];
} = {}) {
  const openTask = vi.fn<CollaborationTaskRepository["openTask"]>(
    parts.openTask ?? (async () => opened),
  );
  const runRound = vi.fn<CapabilityFollowUpCoordinator["runRound"]>(
    parts.runRound ?? (async () => completed),
  );
  const endTask = vi.fn<CollaborationTaskRepository["endTask"]>(
    parts.endTask ?? (async () => ({ outcome: "ended", status: "completed" })),
  );
  const service = new DraftFollowUpService({
    tasks: { openTask, endTask },
    coordinator: { runRound } as unknown as CapabilityFollowUpCoordinator,
    newTaskId: () => taskId,
  });
  return { service, openTask, endTask, runRound };
}

describe("carrying a draft's questions to the other machine", () => {
  it("hands back only the files a human over there allowed", async () => {
    const { service } = build();

    await expect(service.run(draft, [ask])).resolves.toEqual([
      { resourceId, content: "rotate();", truncated: false },
    ]);
  });

  it("takes the scope from the task, never from the draft", async () => {
    const { service, openTask, runRound } = build();

    await service.run(draft, [ask]);

    // The draft supplies only the message it is answering and who is asking.
    expect(openTask).toHaveBeenCalledWith({
      taskId,
      originSharedMessageId: messageId,
      responderUserId: responderId,
    });
    // Everything that decides where the question may go came back from the
    // record: the repository the draft named is not the one used.
    expect(runRound).toHaveBeenCalledWith(
      {
        taskId,
        conversationId,
        githubRepositoryId: "1345851084",
        ownerUserId: requesterId,
        peerUserId: responderId,
      },
      [ask],
    );
  });

  it("asks for nothing on a draft with no crossing message behind it", async () => {
    const { service, openTask } = build();

    // A sender draft opens no task, so its agent has no one to ask and no
    // round to spend. One approved message is one collaboration.
    await expect(
      service.run({ ...draft, incomingMessageId: null }, [ask]),
    ).resolves.toEqual([]);
    expect(openTask).not.toHaveBeenCalled();
  });

  it("says nothing when a task cannot be opened", async () => {
    const { service, runRound } = build({
      openTask: async () => ({ outcome: "unavailable" }),
    });

    await expect(service.run(draft, [ask])).resolves.toEqual([]);
    expect(runRound).not.toHaveBeenCalled();
  });

  it.each([
    ["the budget is gone", { outcome: "exhausted", round: 5 } as const],
    ["there is nowhere to deliver", { outcome: "unroutable", round: 1 } as const],
    ["the task is not available", { outcome: "task_unavailable" } as const],
  ])("returns nothing at all when %s", async (_case, outcome) => {
    const { service } = build({ runRound: async () => outcome });

    // Why a round produced nothing is never reported upward. The asking agent
    // must not be able to tell a waiting human from a refusal from a file that
    // does not exist.
    await expect(service.run(draft, [ask])).resolves.toEqual([]);
  });

  it("reuses the task an earlier round already opened", async () => {
    const { service, runRound } = build({
      openTask: async () => ({ ...opened, outcome: "existing" }),
    });

    await service.run(draft, [ask]);

    // A retried send lands on the same task rather than buying a second budget
    // of five rounds.
    expect(runRound).toHaveBeenCalledWith(
      expect.objectContaining({ taskId }),
      [ask],
    );
  });

  it.each(["completed", "cancelled"] as const)(
    "ends the existing task as %s when the recipient draft finishes",
    async (status) => {
      const { service, endTask } = build({
        openTask: async () => ({ ...opened, outcome: "existing" }),
      });

      await service.end(draft, status);

      expect(endTask).toHaveBeenCalledWith({
        taskId,
        actorUserId: responderId,
        status,
      });
    },
  );

  it("fails safely when durable task closure is unavailable", async () => {
    const { service } = build({
      endTask: async () => ({ outcome: "unavailable" }),
    });

    await expect(service.end(draft, "completed")).rejects.toThrow(
      "Collaboration task could not be closed",
    );
  });
});
