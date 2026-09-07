import type { PrivateDraftView } from "./api";

export type DraftResponseReveal = {
  draftId: string;
  responseVersion: string;
  firstNewTurnIndex: number;
};

const REVEALABLE_STATES = new Set<PrivateDraftView["state"]>([
  "needs_clarification",
  "ready",
  "blocked",
]);

/**
 * A response animates only when a live provider turn settles. Existing and
 * recovered draft content must be immediately readable instead of replaying.
 */
export function draftResponseReveal(
  previous: PrivateDraftView | null,
  next: PrivateDraftView,
): DraftResponseReveal | null {
  if (
    !previous ||
    previous.draftId !== next.draftId ||
    (previous.state !== "created" && previous.state !== "agent_working") ||
    !REVEALABLE_STATES.has(next.state)
  ) {
    return null;
  }

  return {
    draftId: next.draftId,
    responseVersion: next.updatedAt,
    firstNewTurnIndex: previous.privateTurns.length,
  };
}
