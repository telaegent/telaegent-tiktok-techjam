import type {
  AgentProvider,
  RuntimeProgressSink,
} from "./runtime-contract.js";

export type MockRelayStage =
  | "sender_prepare"
  | "recipient_reply"
  | "sender_receive";

export interface MockRelayTurnRequest {
  stage: MockRelayStage;
  input: string;
  sessionId?: string;
}

export interface MockRelayTurnResult {
  message: string;
  sessionId?: string;
}

export interface MockRelayEndpoint {
  provider: AgentProvider;
  runTurn(
    request: MockRelayTurnRequest,
    onProgress?: RuntimeProgressSink,
  ): Promise<MockRelayTurnResult>;
}

export interface MockRelayApproval {
  from: AgentProvider;
  to: AgentProvider;
  message: string;
}

export interface MockRelayTranscript {
  senderDraft: string;
  recipientReply: string;
  senderReceipt: string;
  senderSessionId?: string;
  recipientSessionId?: string;
}

export class MockRelayCancelledError extends Error {
  constructor() {
    super("Mock relay stopped at the approval boundary");
    this.name = "MockRelayCancelledError";
  }
}

export async function runMockAgentRelay(options: {
  sender: MockRelayEndpoint;
  recipient: MockRelayEndpoint;
  instruction: string;
  approve: (candidate: MockRelayApproval) => Promise<string | null>;
  onProgress?: RuntimeProgressSink;
}): Promise<MockRelayTranscript> {
  const senderDraft = await options.sender.runTurn(
    { stage: "sender_prepare", input: options.instruction },
    options.onProgress,
  );
  const approvedRequest = await options.approve({
    from: options.sender.provider,
    to: options.recipient.provider,
    message: senderDraft.message,
  });
  if (approvedRequest === null) throw new MockRelayCancelledError();

  const recipientReply = await options.recipient.runTurn(
    { stage: "recipient_reply", input: approvedRequest },
    options.onProgress,
  );
  const approvedReply = await options.approve({
    from: options.recipient.provider,
    to: options.sender.provider,
    message: recipientReply.message,
  });
  if (approvedReply === null) throw new MockRelayCancelledError();

  const senderReceipt = await options.sender.runTurn(
    {
      stage: "sender_receive",
      input: approvedReply,
      ...(senderDraft.sessionId ? { sessionId: senderDraft.sessionId } : {}),
    },
    options.onProgress,
  );

  return {
    senderDraft: approvedRequest,
    recipientReply: approvedReply,
    senderReceipt: senderReceipt.message,
    ...(senderDraft.sessionId ? { senderSessionId: senderDraft.sessionId } : {}),
    ...(recipientReply.sessionId
      ? { recipientSessionId: recipientReply.sessionId }
      : {}),
  };
}
