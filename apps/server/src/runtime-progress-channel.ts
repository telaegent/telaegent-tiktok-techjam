import { randomUUID } from "node:crypto";
import type { GitHubRepositoryId } from "./authorization/types.js";
import type { RuntimeProgressEvent } from "./runtime-contract.js";

export interface RuntimeProgressOwner {
  userId: string;
  /** Stable GitHub numeric repository ID represented as a decimal string. */
  githubRepositoryId: GitHubRepositoryId;
  conversationId: string;
}

export interface RuntimeProgressEnvelope {
  sequence: number;
  occurredAt: string;
  progress: RuntimeProgressEvent;
}

export interface RuntimeProgressSubscription {
  replay: RuntimeProgressEnvelope[];
  unsubscribe(): void;
}

type RuntimeProgressListener = (event: RuntimeProgressEnvelope) => void;

interface ChannelState {
  owner: RuntimeProgressOwner;
  nextSequence: number;
  replay: RuntimeProgressEnvelope[];
  listeners: Set<RuntimeProgressListener>;
}

const validOwnerPart = /^[^\u0000\r\n]{1,256}$/;
const validGitHubRepositoryId = /^[1-9][0-9]{0,19}$/;

/**
 * Bounded, in-memory bridge between a private CLI turn and a realtime
 * transport. An HTTP/SSE adapter must authenticate the caller and pass the
 * authenticated owner scope to `subscribe`; possession of a stream ID alone
 * is deliberately insufficient.
 */
export class RuntimeProgressChannel {
  private readonly channels = new Map<string, ChannelState>();

  constructor(
    private readonly replayLimit = 100,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(replayLimit) || replayLimit < 0 || replayLimit > 1_000) {
      throw new Error("Runtime progress replay limit is invalid");
    }
  }

  open(owner: RuntimeProgressOwner): string {
    this.validateOwner(owner);
    const streamId = randomUUID();
    this.channels.set(streamId, {
      owner: structuredClone(owner),
      nextSequence: 1,
      replay: [],
      listeners: new Set(),
    });
    return streamId;
  }

  publish(streamId: string, progress: RuntimeProgressEvent): boolean {
    const channel = this.channels.get(streamId);
    if (!channel) return false;
    const envelope: RuntimeProgressEnvelope = {
      sequence: channel.nextSequence++,
      occurredAt: this.now().toISOString(),
      progress: structuredClone(progress),
    };
    if (this.replayLimit > 0) {
      channel.replay.push(envelope);
      if (channel.replay.length > this.replayLimit) channel.replay.shift();
    }
    for (const listener of channel.listeners) {
      try {
        listener(structuredClone(envelope));
      } catch {
        // A disconnected browser must never fail or cancel the provider turn.
      }
    }
    return true;
  }

  subscribe(
    streamId: string,
    owner: RuntimeProgressOwner,
    listener: RuntimeProgressListener,
  ): RuntimeProgressSubscription | null {
    this.validateOwner(owner);
    const channel = this.channels.get(streamId);
    if (!channel || !sameOwner(channel.owner, owner)) return null;
    channel.listeners.add(listener);
    let active = true;
    return {
      replay: structuredClone(channel.replay),
      unsubscribe: () => {
        if (!active) return;
        active = false;
        channel.listeners.delete(listener);
      },
    };
  }

  close(streamId: string, owner: RuntimeProgressOwner): boolean {
    this.validateOwner(owner);
    const channel = this.channels.get(streamId);
    if (!channel || !sameOwner(channel.owner, owner)) return false;
    channel.listeners.clear();
    return this.channels.delete(streamId);
  }

  private validateOwner(owner: RuntimeProgressOwner): void {
    for (const value of [owner.userId, owner.conversationId]) {
      if (!validOwnerPart.test(value)) {
        throw new Error("Runtime progress owner is invalid");
      }
    }
    if (!validGitHubRepositoryId.test(owner.githubRepositoryId)) {
      throw new Error("Runtime progress owner is invalid");
    }
  }
}

function sameOwner(
  left: RuntimeProgressOwner,
  right: RuntimeProgressOwner,
): boolean {
  return (
    left.userId === right.userId &&
    left.githubRepositoryId === right.githubRepositoryId &&
    left.conversationId === right.conversationId
  );
}
