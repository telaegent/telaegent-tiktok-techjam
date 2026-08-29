export interface ConversationWorkRequest {
  projectId: string;
  conversationId: string;
  operationId: string;
  requestId: string;
  correlationId: string;
  ownerId: string;
  agentId: string;
  content: string;
}

export interface ConversationWorkResult {
  publicSummary: string;
  intent: IntentCandidate;
}

export interface IntentCandidate {
  task: string;
  branch: string;
  plannedFiles: string[];
  interfaces: string[];
  dependencies: string[];
  planSteps: string[];
}

export interface IntentForConflict extends IntentCandidate {
  intentId: string;
  projectId: string;
  ownerId: string;
  agentId: string;
  changedFiles: string[];
  baseCommit: string | null;
}

export interface ConflictSignal {
  type: string;
  score: number;
  value: string;
}

export interface ConflictEvaluation {
  score: number;
  signals: ConflictSignal[];
}

export interface IntentConflictEvaluator {
  evaluate(
    candidate: IntentForConflict,
    activeIntents: IntentForConflict[],
  ): ConflictEvaluation;
}

export interface ConversationOrchestrator {
  processMessage(request: ConversationWorkRequest): Promise<ConversationWorkResult>;
}

export class RuntimeUnavailableConversationOrchestrator
  implements ConversationOrchestrator
{
  async processMessage(
    _request: ConversationWorkRequest,
  ): Promise<ConversationWorkResult> {
    throw new Error("Telaegent runtime integration is not available");
  }
}

export class RuntimeUnavailableConflictEvaluator
  implements IntentConflictEvaluator
{
  evaluate(
    _candidate: IntentForConflict,
    _activeIntents: IntentForConflict[],
  ): ConflictEvaluation {
    throw new Error("Telaegent conflict engine integration is not available");
  }
}
