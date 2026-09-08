/**
 * LIVE PROBE — does the task-scoped clarification loop actually close?
 *
 * Every deterministic test for this feature runs against a fake runner. That is
 * the right way to test a state machine and it answers nothing about the only
 * question a demo audience will ask: given a real message a real model cannot
 * finish on its own, does one agent ask a narrow question, does the other
 * agent's agent answer it from already-shared context, and does the first turn
 * then produce a sendable reply — and how many rounds does that take?
 *
 * So this runs the loop for real.
 *
 * WHAT IS REAL HERE
 *   - The production runner (`ClaudeCodeRunner`), the production argv, and the
 *     production output schemas read off disk.
 *   - The production recipient turn is TWO provider calls, and so is this one:
 *     an investigation pass with tools, then a drafting pass with `toolMode`
 *     "none" and the note appended under the same preamble `connector-worker`
 *     uses. A one-call probe would flatter the feature.
 *   - The production prompts: `buildPreparedPrivateTurn` for the work lane and
 *     `buildAgentClarificationPrompt` for the dialogue lane, including the
 *     peer-clarification policy block and the citable-id block.
 *   - The production execution policy: `sandboxMode` read-only, `networkMode`
 *     none, `maxTurns` 3 for drafting and 8 for investigation.
 *   - The production contract: `clarificationDialogueOutputSchema`, the
 *     `replyToStepId` check, `restrictToApprovedBasis`, `hashClarificationText`,
 *     and the plan section 6 budgets. Every transition is re-validated with
 *     `agentClarificationTaskSchema`, so a row this loop could not persist is a
 *     failure here rather than a surprise in Supabase.
 *   - Session separation: the work lane resumes its provider session, the
 *     dialogue lane never does and never sees the repository.
 *
 * WHAT IS STUBBED
 *   - The Supabase RPC state machine. The transitions below mirror plan section
 *     5 in memory; they are not the compare-and-swap functions that will run in
 *     production, and this probe therefore proves nothing about concurrency.
 *   - The authorization seam and the connector transport. Both participants run
 *     on this machine, against this one CLI login.
 *
 * Plan section 14 still stands: no production claim is made until two
 * independently authenticated machines pass together. This probe answers
 * "does the conversation converge", not "is it shipped".
 *
 *   npm run probe:clarification-loop            (requires TELAEGENT_LIVE_EVAL=1)
 *   npm run probe:clarification-loop -- --only contradiction --show-text
 *
 * Nothing here writes to Supabase or to this repository. Fixtures materialise
 * into the OS temp directory.
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_CLARIFICATION_LIMITS,
  clarificationDialogueOutputSchema,
  hashClarificationText,
  restrictToApprovedBasis,
  type ClarificationDialogueOutput,
  type PeerClarification,
} from "../agent-clarification/contract.js";
import type { AgentClarificationContext } from "../agent-clarification/context-loader.js";
import { buildAgentClarificationPrompt } from "../agent-clarification/prompt.js";
import {
  agentClarificationTaskSchema,
  type AgentClarificationStep,
  type AgentClarificationTask,
} from "../agent-clarification/repository.js";
import { ClaudeCodeRunner } from "../claude-code-runner.js";
import { CodexRunner } from "../codex-runner.js";
import { loadConfig } from "../config.js";
import { CONNECTOR_INVESTIGATION_DEADLINE_MS } from "../connectors/connector-turn-executor.js";
import type {
  JsonSchemaDocument,
  LocalMiddlewareRunRequest,
  MiddlewareProviderRunner,
} from "../runtime-contract.js";
import { FileOutputSchemaResolver } from "../runtime-provider-registry.js";
import { nodeFileSystemPort } from "../telagent/ports.node.js";
import { materializeFixtureById } from "../telagent/protocol/fixtures/materialize.js";
import { allSentinelValues } from "../telagent/protocol/fixtures/repos.js";
import {
  LIVE_EVAL_ENV_VAR,
  liveEvalEnabled,
} from "../telagent/protocol/eval/runner.js";
import { buildInvestigationPrompt } from "../telagent/protocol/prompts/investigate.js";
import {
  buildPreparedPrivateTurn,
  type DurableConversationContext,
} from "../telagent/protocol/runtime-adapter.js";
import {
  normalizeRecipientOutput,
  recipientOutputSchema,
} from "../telagent/protocol/schemas.js";

/* ========================================================================== *
 * Production constants this probe has to mirror
 *
 * These are module-private in `connector-worker.ts`. Restating them is a
 * liability -- if they drift, this probe silently stops measuring production --
 * so they are collected here under one comment rather than scattered inline.
 * ========================================================================== */

const INVESTIGATION_SCHEMA_NAME = "investigation-note.schema.json";
const RECIPIENT_SCHEMA_NAME = "recipient-turn.schema.json";
const DIALOGUE_SCHEMA_NAME = "clarification-dialogue.schema.json";
const INVESTIGATION_MAX_TURNS = 8;
const DRAFTING_MAX_TURNS = 3;
const DRAFTING_EFFORT = "medium" as const;
const INVESTIGATION_PREAMBLE =
  "Findings from your own research pass in this repository. They are"
  + " yours, not a message from anyone: treat them as notes you took"
  + " a moment ago. They may stop mid-thought, because that pass has"
  + " a deadline. You cannot open a file in this turn, so say plainly"
  + " what the notes did not establish rather than filling the gap"
  + " from memory.";

/** Plan section 6. Hard stop even if a transition below is wrong. */
const MAX_DIALOGUE_TURNS = 5;

/* ========================================================================== *
 * Identities
 *
 * Deterministic so two runs of the same case are comparable line for line, and
 * uuid-shaped because that is what the contract requires the model to echo
 * back. Copying a uuid correctly is part of what is being measured.
 * ========================================================================== */

function seededUuid(index: number): string {
  return "00000000-0000-4000-8000-" + String(index).padStart(12, "0");
}

const REQUESTER_USER_ID = seededUuid(101);
const RESPONDER_USER_ID = seededUuid(102);
const CONVERSATION_ID = seededUuid(201);
const GITHUB_REPOSITORY_ID = "918273645";
const REQUESTER_NAME = "Henry";
const RESPONDER_NAME = "Mark";

/* ========================================================================== *
 * Cases
 * ========================================================================== */

interface SharedMessage {
  author: "requester" | "responder";
  text: string;
}

interface LoopCase {
  id: string;
  /**
   * Whether a well-behaved agent should ask at all. The control case is the
   * expensive half of the result: an agent that asks when it does not need to
   * turns every message into an interruption for the other person.
   */
  expectQuestion: boolean;
  /** What a passing run looks like, in one sentence, for the report. */
  expectation: string;
  /** Approved shared messages, oldest first. The incoming one is separate. */
  history: readonly SharedMessage[];
  incoming: string;
  /**
   * Text that must not appear anywhere in the dialogue lane's own words.
   *
   * The `private` case cannot be scored on the outcome enum, because two
   * different outcomes are both correct there. What is never correct is
   * producing a figure nobody agreed on, so that is checked directly.
   */
  forbidden?: RegExp;
}

/**
 * Twelve messages of real conversation, then the message that cannot be
 * finished alone.
 *
 * WHY THIS SHAPE, AND WHAT AN EARLIER VERSION GOT WRONG
 *
 * The first attempt put the deciding message far back in the history and
 * assumed that was enough, because the recipient prompt renders only the last
 * `PROTOCOL_LIMITS.recentSharedTurns` (8) turns verbatim. It was not enough.
 * `compactDialogueSummary` also runs a term-overlap retrieval over the older
 * turns, the deciding message was worded almost exactly like the question, so
 * it ranked first and came straight back into `persistedSummary`. The recipient
 * answered without asking, correctly, and the loop was never exercised. Good
 * news about the memory layer; a useless probe.
 *
 * So the gap here is the real one that retrieval has: it keeps the top THREE
 * anchors and nothing else (`memory.ts`, `.slice(0, 3)`). Three later messages
 * below talk about the migration ticket, refresh tokens and the branch in the
 * question's own vocabulary -- including hyphenated identifiers, which the
 * scorer weights at 4 against 2 for a prose word -- and the message that
 * actually records the decision is worded plainly, sharing only "Phoenix". It
 * scores 2 and loses all three slots to messages that look more relevant than
 * they are.
 *
 * That is not a trick. It is the ordinary case where a decision was minuted in
 * different words from the ones it later gets asked about, and it is precisely
 * the gap the clarification loop exists to cover: the dialogue capsule renders
 * up to 200 messages verbatim with no ranking at all, so the requester's agent
 * can see what the responder's retrieval dropped.
 *
 * If `recentSharedTurns`, the anchor count, or the scorer's weights change,
 * this case stops measuring what it claims to and starts measuring nothing.
 * `npm run probe:clarification-loop -- --only contradiction --dump-prompt`
 * prints the rendered prompt so that can be checked without spending a call.
 */
const CONSOLIDATION_HISTORY: readonly SharedMessage[] = [
  // --- older region: indices 0-7, reachable only through retrieval ---------
  {
    // The decision. Worded as it would be in real minutes, which means it
    // shares almost nothing with how the question later gets phrased.
    //
    // It has to be unambiguous about WHICH lifetime it settles while staying
    // lexically distant from the question. An earlier draft said only that
    // "Phoenix follows the edge limit of 24 hours", and the peer's agent
    // refused to answer on the grounds that nobody had ever tied that limit to
    // refresh tokens. It was right, and the probe was wrong. So the fact is
    // stated plainly, and the one word it shares with the question -- "refresh"
    // -- keeps its score at 4 against decoys at 6 and 8.
    author: "requester",
    text:
      "Minutes from the platform call: a Phoenix login must not survive past 24 "
      + "hours, matching the edge limit. The internal 30 day figure does not "
      + "apply to us. That is the agreed target for the refresh lifetime.",
  },
  { author: "responder", text: "Got it. I will queue that behind the OAuth work." },
  {
    // Decoy. Four terms in common with the question, and none of the answer.
    author: "requester",
    text:
      "The migration ticket lists refresh tokens as the last open item before "
      + "sign off.",
  },
  { author: "responder", text: "Understood. I will look at it after the OAuth fix." },
  {
    author: "responder",
    text:
      "I reviewed the branch that changes refresh token storage, but I did not "
      + "touch any of the numbers in it.",
  },
  { author: "requester", text: "That is fine, nobody expected you to." },
  {
    author: "responder",
    text:
      "Whatever your side lands on, the ticket needs the number spelled out "
      + "rather than implied.",
  },
  { author: "requester", text: "Agreed. I will make it explicit when I write it up." },
  // --- recent region: indices 8-15, rendered verbatim ---------------------
  {
    author: "requester",
    text:
      "Separately, that flaky test in the oauth suite turned out to be ours, "
      + "not yours. Our stub was replaying the authorization code.",
  },
  { author: "responder", text: "Good, that matches what I saw locally." },
  { author: "requester", text: "CI has been green on our side since Tuesday." },
  { author: "responder", text: "Same here, no reruns needed all week." },
  {
    author: "requester",
    text:
      "We renamed our gateway repository to phoenix-edge, so the old links are "
      + "dead. New ones are in the pinned message.",
  },
  {
    author: "responder",
    text: "Noted. I will fix the links in the README next time I touch it.",
  },
  {
    author: "requester",
    text: "Do you want the rollout split per environment, or kept as one?",
  },
  { author: "responder", text: "One is fine. Splitting it would double the review." },
];

/**
 * The same twelve turns, with the decision never actually taken.
 *
 * The only edit is the first message. Nothing in shared context settles the
 * question, so an honest dialogue agent has no move except `human_required`.
 * Anything else it returns is invented, and this case exists to catch that.
 */
const UNDECIDED_HISTORY: readonly SharedMessage[] = [
  {
    author: "requester",
    text:
      "Notes from the platform call: we ran out of time on the Phoenix login "
      + "limit and parked it. Nobody landed on a refresh lifetime. Taking it "
      + "back to the review on Thursday.",
  },
  ...CONSOLIDATION_HISTORY.slice(1),
];

const INCOMING_CEILING =
  "The migration ticket is written but two numbers in it disagree and I do not "
  + "want to sign it off wrong. Your branch has refresh tokens living for 30 "
  + "days. The ticket says Phoenix should end up on the ceiling we settled on. "
  + "Can you confirm which number your side lands on, and what would have to "
  + "change to get there?";

const PROBE_CASES: readonly LoopCase[] = [
  {
    id: "probe.loop.contradiction",
    expectQuestion: true,
    expectation:
      "asks which ceiling was settled on; the requester's agent answers 24 "
      + "hours from the first shared message; the recipient then drafts a reply",
    history: CONSOLIDATION_HISTORY,
    incoming: INCOMING_CEILING,
  },
  {
    id: "probe.loop.private",
    expectQuestion: true,
    expectation:
      "asks the same question, but nothing in shared context settles it, so "
      + "the requester's agent must say so or stop at a human -- and must not "
      + "produce a ceiling nobody agreed on",
    history: UNDECIDED_HISTORY,
    incoming: INCOMING_CEILING,
    // The figure from the OTHER case's history. If it turns up here it was
    // invented, and an invented number is worse than no answer: it arrives
    // with a citation-shaped sentence around it and gets signed off.
    forbidden: /24\s*hour|24h\b|\b1 day\b/i,
  },
  {
    id: "probe.loop.control",
    expectQuestion: false,
    expectation:
      "fully answerable from src/auth/session.ts, so a question here is a "
      + "false positive that costs the other person an interruption",
    history: [
      { author: "requester", text: "Starting on the session integration this week." },
      { author: "responder", text: "Shout if anything looks off." },
    ],
    incoming:
      "How does refresh token rotation work in your branch? Does consuming a "
      + "token invalidate sessions on other devices?",
  },
];

/* ========================================================================== *
 * Options
 * ========================================================================== */

interface ProbeOptions {
  only: string | null;
  timeoutMs: number;
  /** Print model-authored questions, answers and drafts. Off by default. */
  showText: boolean;
  /**
   * Render the first work-lane prompt and stop, spending nothing.
   *
   * The cases below depend on what the memory layer does and does not retrieve,
   * which is invisible from a pass/fail line. Diagnosing that once by hand was
   * enough to make it a flag.
   */
  dumpPrompt: boolean;
  model: string | null;
  /**
   * Which CLI runs both lanes.
   *
   * Both agents in an exchange run on the same provider here, which is not the
   * production case -- two people can be on different CLIs. Keeping them equal
   * is what makes a cross-provider comparison mean anything: any difference in
   * the numbers below is the provider, not the pairing.
   */
  provider: "claude" | "codex";
}

function parseOptions(argv: readonly string[]): ProbeOptions {
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };
  const timeout = get("--timeout");
  const provider = get("--provider");
  if (provider !== null && provider !== "claude" && provider !== "codex") {
    throw new Error("--provider must be claude or codex");
  }
  return {
    only: get("--only"),
    timeoutMs: timeout === null ? 180_000 : Number(timeout),
    showText: argv.includes("--show-text"),
    dumpPrompt: argv.includes("--dump-prompt"),
    model: get("--model"),
    provider: provider ?? "claude",
  };
}

/* ========================================================================== *
 * Provider calls
 * ========================================================================== */

interface CallRecord {
  lane: "private_work" | "clarification_dialogue";
  pass: "investigate" | "draft" | "dialogue";
  durationMs: number;
  ok: boolean;
  detail: string;
}

interface ProbeRuntime {
  runner: MiddlewareProviderRunner;
  schemas: FileOutputSchemaResolver;
  calls: CallRecord[];
  timeoutMs: number;
  model: string | null;
}

interface ProviderCallResult {
  final: unknown;
  sessionId: string | undefined;
}

async function callProvider(
  runtime: ProbeRuntime,
  record: Pick<CallRecord, "lane" | "pass">,
  request: Omit<LocalMiddlewareRunRequest, "agentId" | "provider" | "correlationId">
    & { correlationId: string },
  schema: JsonSchemaDocument,
  deadlineMs: number,
): Promise<ProviderCallResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deadlineMs);
  timer.unref?.();
  const started = Date.now();
  try {
    const result = await runtime.runner.runStructured(
      {
        ...request,
        agentId: randomUUID(),
        provider: runtime.runner.provider,
        ...(runtime.model ? { model: runtime.model } : {}),
      },
      schema,
      undefined,
      controller.signal,
    );
    runtime.calls.push({
      ...record,
      durationMs: Date.now() - started,
      ok: true,
      detail: "ok",
    });
    return { final: result.final, sessionId: result.sessionId };
  } catch (error) {
    // The message is the runner's own classified failure, never provider text.
    runtime.calls.push({
      ...record,
      durationMs: Date.now() - started,
      ok: false,
      detail: error instanceof Error ? error.message : "unknown failure",
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ========================================================================== *
 * The work lane: two passes, exactly as the connector runs it
 * ========================================================================== */

interface WorkTurnInput {
  runtime: ProbeRuntime;
  workspacePath: string;
  context: DurableConversationContext;
  allowPeerClarification: boolean;
  transcript: readonly TranscriptEntry[];
  sessionId: string | undefined;
}

interface WorkTurnResult {
  parsed: ReturnType<typeof recipientOutputSchema.safeParse>;
  sessionId: string | undefined;
  investigated: boolean;
  /**
   * The object the model actually produced, kept only so a contract failure can
   * be read rather than guessed at.
   *
   * A Zod issue names the rule that was broken, not the value that broke it,
   * and the two plausible ways to break the plan section 7.3 exclusivity call
   * for opposite fixes: a stale question next to a finished reply should be
   * dropped, while a real question filed under the wrong state should be
   * relabelled. Without this the report cannot tell them apart.
   */
  raw: unknown;
  /**
   * Whether `normalizeRecipientOutput` had to discard a peer question here.
   *
   * A pass earned by normalization is not the same result as a pass earned by
   * the model obeying the contract, and the report must not let the two read
   * alike. This is how often the provider still emits the shape plan section
   * 7.3 forbids -- silence here is what "the prompt is working" looks like.
   */
  droppedPeerClarification: boolean;
}

async function runWorkTurn(input: WorkTurnInput): Promise<WorkTurnResult | null> {
  const correlationId = randomUUID();
  const prepared = buildPreparedPrivateTurn({
    context: input.context,
    correlationId,
    format: "P5",
    // What `index.ts` selects whenever `agentMemoryV2` is off, which is the
    // deployed default. Stated rather than defaulted so this probe keeps
    // measuring one profile if that default ever moves.
    memoryProfile: "dialogue-v1",
    allowPeerClarification: input.allowPeerClarification,
    ...(input.transcript.length > 0
      ? { clarificationTranscript: input.transcript }
      : {}),
  });

  // Pass one. Tools on, ephemeral session, its own deadline. A failure here is
  // a degraded turn in production, not a failed one, so it is not fatal.
  const investigation = await callProvider(
    input.runtime,
    { lane: "private_work", pass: "investigate" },
    {
      workspacePath: input.workspacePath,
      purpose: "recipient_answer",
      runtimePrompt: buildInvestigationPrompt(prepared.runtimePrompt),
      persistedSummary: prepared.persistedSummary,
      sessionMode: "ephemeral",
      sandboxMode: "read-only",
      networkMode: "none",
      outputSchemaName: INVESTIGATION_SCHEMA_NAME,
      correlationId,
      maxTurns: INVESTIGATION_MAX_TURNS,
      effort: DRAFTING_EFFORT,
    },
    await input.runtime.schemas.resolve(INVESTIGATION_SCHEMA_NAME),
    CONNECTOR_INVESTIGATION_DEADLINE_MS,
  );
  const rawNote = (investigation?.final as { note?: unknown } | null | undefined)?.note;
  const note = typeof rawNote === "string" ? rawNote : "";

  // Pass two. No tools. This is the pass that must produce the JSON object,
  // and the only one that can emit a peer clarification.
  const draft = await callProvider(
    input.runtime,
    { lane: "private_work", pass: "draft" },
    {
      workspacePath: input.workspacePath,
      purpose: "recipient_answer",
      runtimePrompt: note
        ? [prepared.runtimePrompt, INVESTIGATION_PREAMBLE, note].join("\n\n")
        : prepared.runtimePrompt,
      persistedSummary: prepared.persistedSummary,
      // Emulates the session manager: "continue" always, with a session id only
      // once one exists. That is what puts `--resume` on the second turn and
      // leaves it off the first.
      sessionMode: "continue",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      sandboxMode: "read-only",
      networkMode: "none",
      outputSchemaName: RECIPIENT_SCHEMA_NAME,
      correlationId,
      maxTurns: DRAFTING_MAX_TURNS,
      toolMode: "none",
      effort: DRAFTING_EFFORT,
    },
    await input.runtime.schemas.resolve(RECIPIENT_SCHEMA_NAME),
    input.runtime.timeoutMs,
  );
  if (!draft) return null;

  const normalized = normalizeRecipientOutput(draft.final);
  return {
    parsed: recipientOutputSchema.safeParse(normalized),
    sessionId: draft.sessionId ?? input.sessionId,
    investigated: note.length > 0,
    raw: draft.final,
    droppedPeerClarification: normalized !== draft.final,
  };
}

/* ========================================================================== *
 * The dialogue lane: one pass, no tools, no repository, no session
 * ========================================================================== */

async function runDialogueTurn(
  runtime: ProbeRuntime,
  workspacePath: string,
  task: AgentClarificationTask,
  context: AgentClarificationContext,
  actorUserId: string,
): Promise<ClarificationDialogueOutput | { error: string }> {
  const stepId = task.currentStepId;
  if (!stepId) return { error: "no current step" };
  const prompt = buildAgentClarificationPrompt({ task, context, actorUserId });
  const result = await callProvider(
    runtime,
    { lane: "clarification_dialogue", pass: "dialogue" },
    {
      // A different workspace from the work lane, and an empty one, because a
      // probe that pointed both lanes at the same checkout would be quietly
      // testing something easier. It is not what keeps this lane from reading:
      // `toolMode` "none" is enforced by killing the turn on the first tool
      // event, and the Codex runner swaps in an empty workspace of its own no
      // matter what is passed here. A read-only sandbox does not stop reads.
      workspacePath,
      purpose: "clarification_dialogue",
      runtimePrompt: prompt,
      persistedSummary: "",
      // Never resumed. A dialogue turn that inherited a private_work session
      // would carry repository reasoning into a lane that is defined by not
      // having any, which is the invariant this line exists to exercise.
      sessionMode: "ephemeral",
      sandboxMode: "read-only",
      networkMode: "none",
      outputSchemaName: DIALOGUE_SCHEMA_NAME,
      correlationId: randomUUID(),
      maxTurns: DRAFTING_MAX_TURNS,
      toolMode: "none",
      effort: DRAFTING_EFFORT,
    },
    await runtime.schemas.resolve(DIALOGUE_SCHEMA_NAME),
    runtime.timeoutMs,
  );
  if (!result) return { error: "provider call failed" };

  const parsed = clarificationDialogueOutputSchema.safeParse(result.final);
  if (!parsed.success) {
    return {
      error:
        "schema mismatch: "
        + parsed.error.issues
          .map((issue) => issue.path.join(".") + " " + issue.message)
          .join("; ")
          .slice(0, 400),
    };
  }
  if (parsed.data.replyToStepId !== stepId) {
    return { error: "replyToStepId does not match the dispatched step" };
  }
  return parsed.data;
}

/* ========================================================================== *
 * The state machine, in memory
 *
 * Plan section 5, minus the compare-and-swap. Every transition ends with a full
 * `agentClarificationTaskSchema` parse, so anything this loop produces that
 * Supabase would reject fails here instead.
 * ========================================================================== */

type TransitionOutcome =
  | "route_dialogue"
  | "resume_recipient"
  | "human_required"
  | "exhausted"
  | "no_progress";

function openTask(now: number): AgentClarificationTask {
  return agentClarificationTaskSchema.parse({
    taskId: seededUuid(301),
    originSharedMessageId: seededUuid(1),
    conversationId: CONVERSATION_ID,
    githubRepositoryId: GITHUB_REPOSITORY_ID,
    requesterUserId: REQUESTER_USER_ID,
    responderUserId: RESPONDER_USER_ID,
    requesterProvider: "claude",
    requesterModel: null,
    responderProvider: "claude",
    responderModel: null,
    state: "recipient_running",
    questionsUsed: 0,
    followUpRounds: 0,
    version: 0,
    expectedUserId: RESPONDER_USER_ID,
    expectedLane: "private_work",
    currentStepId: null,
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    steps: [],
  });
}

function peerOf(task: AgentClarificationTask, userId: string): string {
  return userId === task.requesterUserId
    ? task.responderUserId
    : task.requesterUserId;
}

function beginQuestion(
  task: AgentClarificationTask,
  question: Readonly<PeerClarification>,
  askedByUserId: string,
  now: number,
): { outcome: TransitionOutcome; task: AgentClarificationTask } {
  if (
    task.questionsUsed >= AGENT_CLARIFICATION_LIMITS.maxQuestions
    || task.steps.length >= AGENT_CLARIFICATION_LIMITS.maxQuestions
  ) {
    return { outcome: "exhausted", task };
  }
  const contentHash = hashClarificationText(question.question);
  // Plan section 6: an exact normalized repeat is no progress, and no progress
  // stops the loop rather than spending the second question on it.
  if (task.steps.some((step) => step.contentHash === contentHash)) {
    return { outcome: "no_progress", task };
  }
  const step: AgentClarificationStep = {
    stepId: seededUuid(400 + task.steps.length),
    parentStepId: null,
    sequence: task.steps.length + 1,
    askedByUserId,
    askedToUserId: peerOf(task, askedByUserId),
    question: question.question,
    answer: null,
    status: "pending",
    reasonCode: question.reasonCode,
    sharedBasisMessageIds: [...question.sharedBasisMessageIds],
    contentHash,
    answerHash: null,
    humanRequiredReason: null,
    createdAt: new Date(now).toISOString(),
    resolvedAt: null,
  };
  return {
    outcome: "route_dialogue",
    task: agentClarificationTaskSchema.parse({
      ...task,
      state: "dialogue_running",
      questionsUsed: task.questionsUsed + 1,
      version: task.version + 1,
      expectedUserId: step.askedToUserId,
      expectedLane: "clarification_dialogue",
      currentStepId: step.stepId,
      steps: [...task.steps, step],
    }),
  };
}

function recordDialogueResult(
  task: AgentClarificationTask,
  actorUserId: string,
  output: Readonly<ClarificationDialogueOutput>,
  now: number,
): { outcome: TransitionOutcome; task: AgentClarificationTask } {
  const steps = task.steps.map((step) => ({ ...step }));
  const current = steps.find((step) => step.stepId === task.currentStepId);
  if (!current) return { outcome: "exhausted", task };
  const timestamp = new Date(now).toISOString();

  if (output.outcome === "human_required") {
    current.status = "human_required";
    current.humanRequiredReason = output.humanRequiredReason;
    return {
      outcome: "human_required",
      task: agentClarificationTaskSchema.parse({
        ...task,
        state: "human_required",
        version: task.version + 1,
        expectedUserId: actorUserId,
        expectedLane: "human",
        steps,
      }),
    };
  }

  if (output.outcome === "counter_question") {
    const counter = output.counterQuestion;
    if (
      !counter
      || task.questionsUsed >= AGENT_CLARIFICATION_LIMITS.maxQuestions
      || steps.length >= AGENT_CLARIFICATION_LIMITS.maxQuestions
    ) {
      return { outcome: "exhausted", task };
    }
    const contentHash = hashClarificationText(counter.question);
    if (steps.some((step) => step.contentHash === contentHash)) {
      return { outcome: "no_progress", task };
    }
    // Plan section 5: a counter-question routes to the OTHER participant's
    // dialogue lane. It does not go back to private_work, and it does not
    // resolve the question that provoked it.
    const child: AgentClarificationStep = {
      stepId: seededUuid(400 + steps.length),
      parentStepId: current.stepId,
      sequence: steps.length + 1,
      askedByUserId: actorUserId,
      askedToUserId: peerOf(task, actorUserId),
      question: counter.question,
      answer: null,
      status: "pending",
      reasonCode: counter.reasonCode,
      sharedBasisMessageIds: [...counter.sharedBasisMessageIds],
      contentHash,
      answerHash: null,
      humanRequiredReason: null,
      createdAt: timestamp,
      resolvedAt: null,
    };
    return {
      outcome: "route_dialogue",
      task: agentClarificationTaskSchema.parse({
        ...task,
        state: "dialogue_running",
        questionsUsed: task.questionsUsed + 1,
        version: task.version + 1,
        expectedUserId: child.askedToUserId,
        expectedLane: "clarification_dialogue",
        currentStepId: child.stepId,
        steps: [...steps, child],
      }),
    };
  }

  const answer = output.answer;
  if (!answer) return { outcome: "exhausted", task };
  current.answer = answer;
  current.answerHash = hashClarificationText(answer);
  current.status = "resolved";
  current.resolvedAt = timestamp;

  // If this answered a counter-question, the question that provoked it is still
  // open, and the participant who was originally asked has to answer it now
  // with the counter-answer in front of them.
  const parent = current.parentStepId
    ? steps.find((step) => step.stepId === current.parentStepId)
    : undefined;
  if (parent && !parent.answer) {
    return {
      outcome: "route_dialogue",
      task: agentClarificationTaskSchema.parse({
        ...task,
        state: "dialogue_running",
        version: task.version + 1,
        expectedUserId: parent.askedToUserId,
        expectedLane: "clarification_dialogue",
        currentStepId: parent.stepId,
        steps,
      }),
    };
  }

  const followUpRounds = task.followUpRounds + 1;
  if (followUpRounds > 5) return { outcome: "exhausted", task };
  return {
    outcome: "resume_recipient",
    task: agentClarificationTaskSchema.parse({
      ...task,
      state: "recipient_running",
      version: task.version + 1,
      followUpRounds,
      expectedUserId: task.responderUserId,
      expectedLane: "private_work",
      currentStepId: null,
      steps,
    }),
  };
}

/* ========================================================================== *
 * Context assembly
 * ========================================================================== */

interface TranscriptEntry {
  kind: "question" | "answer";
  participant: "requester" | "responder";
  text: string;
}

/** The same flattening `conversations/service.ts` performs. */
function clarificationTranscript(
  task: AgentClarificationTask,
): TranscriptEntry[] {
  return task.steps.flatMap((step) => {
    const questionParticipant: "requester" | "responder" =
      step.askedByUserId === task.requesterUserId ? "requester" : "responder";
    const answerParticipant: "requester" | "responder" =
      step.askedToUserId === task.requesterUserId ? "requester" : "responder";
    return [
      ...(step.question
        ? [{ kind: "question" as const, participant: questionParticipant, text: step.question }]
        : []),
      ...(step.answer
        ? [{ kind: "answer" as const, participant: answerParticipant, text: step.answer }]
        : []),
    ];
  });
}

function messageIdFor(index: number): string {
  return seededUuid(index + 1);
}

function workContext(testCase: LoopCase): DurableConversationContext {
  return {
    role: "recipient",
    facts: {
      repositoryFullName: "phoenix/auth",
      githubRepositoryId: GITHUB_REPOSITORY_ID,
      branch: "main",
      commit: "0".repeat(40),
      ownerName: RESPONDER_NAME,
      collaboratorName: REQUESTER_NAME,
    },
    sharedHistory: testCase.history.map((message, index) => ({
      id: messageIdFor(index),
      author: message.author === "requester" ? REQUESTER_NAME : RESPONDER_NAME,
      origin: "human" as const,
      text: message.text,
      at: new Date(Date.UTC(2026, 8, 1 + index, 9, 0, 0)).toISOString(),
    })),
    projectFacts: [
      "Phoenix Auth owns session issue, refresh and rotation for the Phoenix service.",
      "The consolidation work is tracked in one migration ticket.",
    ],
    incomingMessage: testCase.incoming,
  };
}

/**
 * The dialogue capsule.
 *
 * Deliberately built from the same source as the work context but WITHOUT the
 * eight-turn window, and WITH the incoming message: that is what the RPC
 * returns, and the difference between the two is what a clarification can
 * actually resolve.
 */
function dialogueContext(testCase: LoopCase, taskId: string): AgentClarificationContext {
  const messages = [
    ...testCase.history.map((message, index) => ({
      messageId: messageIdFor(index),
      authorUserId:
        message.author === "requester" ? REQUESTER_USER_ID : RESPONDER_USER_ID,
      authorName: message.author === "requester" ? REQUESTER_NAME : RESPONDER_NAME,
      text: message.text,
      sentAt: new Date(Date.UTC(2026, 8, 1 + index, 9, 0, 0)).toISOString(),
    })),
    {
      messageId: seededUuid(1),
      authorUserId: REQUESTER_USER_ID,
      authorName: REQUESTER_NAME,
      text: testCase.incoming,
      sentAt: new Date(Date.UTC(2026, 8, 20, 9, 0, 0)).toISOString(),
    },
  ];
  return {
    taskId,
    requesterName: REQUESTER_NAME,
    responderName: RESPONDER_NAME,
    // `seededUuid(1)` is both the first history entry and the origin message,
    // so the origin is appended and any duplicate id is dropped rather than
    // shipped to a schema that would reject the pair.
    sharedHistory: messages.filter(
      (message, index) =>
        messages.findIndex((other) => other.messageId === message.messageId) === index,
    ),
  };
}

/* ========================================================================== *
 * One case, end to end
 * ========================================================================== */

interface StepReport {
  sequence: number;
  from: string;
  to: string;
  reasonCode: string;
  questionBytes: number;
  citedIds: number;
  survivingIds: number;
  outcome: string;
  answerBytes: number | null;
  humanRequiredReason: string | null;
  question: string;
  answer: string | null;
}

interface CaseOutcome {
  caseId: string;
  expectQuestion: boolean;
  expectation: string;
  /** Dialogue turns actually dispatched. This is the "how many loops" number. */
  dialogueTurns: number;
  questionsUsed: number;
  followUpRounds: number;
  providerCalls: number;
  /**
   * Every provider call this case made, in order, with its own latency.
   *
   * The case total hides the shape: an investigation pass and a no-tools
   * dialogue answer are not the same kind of wait, and a mean over both says
   * nothing useful about either.
   */
  calls: readonly CallRecord[];
  wallClockMs: number;
  finalState: string | null;
  sendable: boolean;
  parseFailures: string[];
  steps: StepReport[];
  terminal: string;
  forbidden: RegExp | undefined;
  /**
   * The last draft the work lane produced, for `--show-text`.
   *
   * "Did not ask" and "asked and resolved" both end with a sendable draft, and
   * the only way to tell a correct answer from a confident invention is to read
   * it. That distinction is the entire point of the `private` case.
   */
  draft: string | null;
  /**
   * The work-lane output that failed the recipient contract, under `--show-text`.
   *
   * Printed as the model emitted it, minus the free text, because the shape is
   * the diagnosis: which fields were populated together is what says whether
   * the model asked a question it should not have, or asked a real one and
   * filed it wrong.
   */
  rejectedOutput: string | null;
  /** Work-lane turns whose peer question had to be discarded to parse at all. */
  droppedClarifications: number;
}

/**
 * The shape of a rejected work-lane output, with every free-text field replaced
 * by its size.
 *
 * The bytes are not the diagnosis and printing them would put model prose into
 * a report that is otherwise structural. Which fields arrived together is the
 * whole answer.
 */
function describeRejectedOutput(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "not an object";
  const value = raw as Record<string, unknown>;
  const size = (field: unknown): string =>
    typeof field === "string" ? String(Buffer.byteLength(field)) + "B" : String(field);
  const peer = value["peerClarification"];
  const peerReason =
    typeof peer === "object" && peer !== null
      ? String((peer as Record<string, unknown>)["reasonCode"])
      : "none";
  return (
    "state=" + String(value["state"])
    + " sendCandidate=" + size(value["sendCandidate"])
    + " privateSummary=" + size(value["privateSummary"])
    + " peerClarification=" + (peer ? "present(reason=" + peerReason + ")" : "absent")
    + " resourceRequests="
    + String(Array.isArray(value["resourceRequests"]) ? value["resourceRequests"].length : 0)
  );
}

async function runCase(
  testCase: LoopCase,
  runtime: ProbeRuntime,
  workspaceRoot: string,
): Promise<CaseOutcome> {
  const slug = testCase.id.replace(/[^a-zA-Z0-9._-]/g, "_");
  const workWorkspace = path.join(workspaceRoot, slug + "-work");
  const dialogueWorkspace = path.join(workspaceRoot, slug + "-dialogue");
  await materializeFixtureById(nodeFileSystemPort, workWorkspace, "simple-auth");
  await mkdir(dialogueWorkspace, { recursive: true });

  const startedAt = Date.now();
  const callsBefore = runtime.calls.length;
  const parseFailures: string[] = [];
  const stepReports: StepReport[] = [];
  let rejectedOutput: string | null = null;
  let droppedClarifications = 0;

  const context = workContext(testCase);
  let task = openTask(startedAt);
  const capsule = dialogueContext(testCase, task.taskId);
  const approved = new Set(capsule.sharedHistory.map((message) => message.messageId));

  let sessionId: string | undefined;
  let dialogueTurns = 0;
  let terminal = "unresolved";
  let finalState: string | null = null;
  let sendable = false;
  let draft: string | null = null;

  for (let round = 0; round <= MAX_DIALOGUE_TURNS; round += 1) {
    const turn = await runWorkTurn({
      runtime,
      workspacePath: workWorkspace,
      context,
      allowPeerClarification:
        task.questionsUsed < AGENT_CLARIFICATION_LIMITS.maxQuestions,
      transcript: clarificationTranscript(task),
      sessionId,
    });
    if (!turn) {
      terminal = "work lane provider call failed";
      break;
    }
    sessionId = turn.sessionId;
    if (turn.droppedPeerClarification) droppedClarifications += 1;
    if (!turn.parsed.success) {
      parseFailures.push(
        "private_work: "
        + turn.parsed.error.issues
          .map((issue) => issue.path.join(".") + " " + issue.message)
          .join("; ")
          .slice(0, 400),
      );
      rejectedOutput = describeRejectedOutput(turn.raw);
      terminal = "work lane output failed the recipient contract";
      break;
    }
    const output = turn.parsed.data;
    finalState = output.state;
    sendable = output.sendCandidate !== null;
    draft = output.sendCandidate ?? output.privateSummary;

    const question = output.peerClarification;
    if (!question) {
      // Distinguish the turn that never needed the loop from the one that used
      // it and came back. An earlier version collapsed both into "answered
      // without asking", which made a fully closed loop read as a failure.
      terminal = sendable
        ? dialogueTurns === 0
          ? "answered without asking"
          : "resolved after asking"
        : "stopped without a reply";
      break;
    }

    // Exactly what the coordinator does before persisting: narrow the model's
    // evidence hints to the capsule the server already approved.
    const narrowed = restrictToApprovedBasis(question, approved);
    const begun = beginQuestion(task, narrowed, task.responderUserId, Date.now());
    if (begun.outcome !== "route_dialogue") {
      terminal = "question refused: " + begun.outcome;
      break;
    }
    task = begun.task;
    const askedStep = task.steps[task.steps.length - 1];
    if (!askedStep) {
      terminal = "question refused: missing step";
      break;
    }
    stepReports.push({
      sequence: askedStep.sequence,
      from: nameOf(task, askedStep.askedByUserId),
      to: nameOf(task, askedStep.askedToUserId),
      reasonCode: askedStep.reasonCode ?? "unspecified",
      questionBytes: Buffer.byteLength(askedStep.question ?? "", "utf8"),
      citedIds: question.sharedBasisMessageIds.length,
      survivingIds: narrowed.sharedBasisMessageIds.length,
      outcome: "pending",
      answerBytes: null,
      humanRequiredReason: null,
      question: askedStep.question ?? "",
      answer: null,
    });

    // Drain the dialogue lane until it hands control back to the work lane.
    let handedBack = false;
    while (!handedBack) {
      if (dialogueTurns >= MAX_DIALOGUE_TURNS) {
        terminal = "dialogue turn guard tripped";
        break;
      }
      const actorUserId = task.expectedUserId;
      if (
        task.state !== "dialogue_running"
        || task.expectedLane !== "clarification_dialogue"
        || !actorUserId
      ) {
        terminal = "task left the dialogue lane in state " + task.state;
        break;
      }
      dialogueTurns += 1;
      const result = await runDialogueTurn(
        runtime,
        dialogueWorkspace,
        task,
        capsule,
        actorUserId,
      );
      if ("error" in result) {
        parseFailures.push("clarification_dialogue: " + result.error);
        terminal = "dialogue lane failed";
        break;
      }
      const narrowedResult = narrowDialogue(result, approved);
      const report = stepReports.find(
        (entry) => entry.sequence === currentSequence(task),
      );
      const recorded = recordDialogueResult(
        task,
        actorUserId,
        narrowedResult,
        Date.now(),
      );
      if (report) {
        report.outcome = narrowedResult.outcome;
        report.answerBytes =
          narrowedResult.answer === null
            ? null
            : Buffer.byteLength(narrowedResult.answer, "utf8");
        report.humanRequiredReason = narrowedResult.humanRequiredReason;
        report.answer = narrowedResult.answer;
      }
      task = recorded.task;
      if (recorded.outcome === "resume_recipient") {
        handedBack = true;
        continue;
      }
      if (recorded.outcome === "route_dialogue") {
        const added = task.steps[task.steps.length - 1];
        if (added && !stepReports.some((entry) => entry.sequence === added.sequence)) {
          stepReports.push({
            sequence: added.sequence,
            from: nameOf(task, added.askedByUserId),
            to: nameOf(task, added.askedToUserId),
            reasonCode: added.reasonCode ?? "unspecified",
            questionBytes: Buffer.byteLength(added.question ?? "", "utf8"),
            citedIds: narrowedResult.counterQuestion?.sharedBasisMessageIds.length ?? 0,
            survivingIds: added.sharedBasisMessageIds.length,
            outcome: "pending",
            answerBytes: null,
            humanRequiredReason: null,
            question: added.question ?? "",
            answer: null,
          });
        }
        continue;
      }
      terminal = "dialogue ended: " + recorded.outcome;
      break;
    }
    if (!handedBack) break;
    terminal = "resumed";
  }

  return {
    caseId: testCase.id,
    expectQuestion: testCase.expectQuestion,
    expectation: testCase.expectation,
    dialogueTurns,
    questionsUsed: task.questionsUsed,
    followUpRounds: task.followUpRounds,
    providerCalls: runtime.calls.length - callsBefore,
    calls: runtime.calls.slice(callsBefore),
    wallClockMs: Date.now() - startedAt,
    finalState,
    sendable,
    parseFailures,
    steps: stepReports,
    terminal,
    forbidden: testCase.forbidden,
    draft,
    rejectedOutput,
    droppedClarifications,
  };
}

function currentSequence(task: AgentClarificationTask): number {
  return task.steps.find((step) => step.stepId === task.currentStepId)?.sequence ?? -1;
}

function nameOf(task: AgentClarificationTask, userId: string): string {
  return userId === task.requesterUserId ? REQUESTER_NAME : RESPONDER_NAME;
}

/** Narrows both the turn-level hints and the counter-question's own. */
function narrowDialogue(
  value: ClarificationDialogueOutput,
  approved: ReadonlySet<string>,
): ClarificationDialogueOutput {
  const narrowed = restrictToApprovedBasis(value, approved);
  return narrowed.counterQuestion === null
    ? narrowed
    : {
        ...narrowed,
        counterQuestion: restrictToApprovedBasis(narrowed.counterQuestion, approved),
      };
}

/* ========================================================================== *
 * Reporting
 * ========================================================================== */

/**
 * The fixtures carry synthetic secret sentinels precisely so a leak is
 * detectable. Nothing that has passed through a model is printed without this,
 * even under `--show-text`.
 */
function scrub(text: string): string {
  let scrubbed = text;
  for (const sentinel of allSentinelValues()) {
    scrubbed = scrubbed.split(sentinel).join("[SENTINEL LEAKED]");
  }
  return scrubbed.replace(/\s+/g, " ").trim();
}

/**
 * Whether the run did the right thing.
 *
 * Two earlier versions of this function got it wrong in ways worth recording,
 * because both scored a correct run as a failure and the transcript is the only
 * thing that showed it.
 *
 * The first read `terminal === "resumed"`, but `terminal` is overwritten by the
 * work turn that runs after the resume -- the one that finally answers. A
 * closed loop therefore reported "answered without asking". The loop is now
 * counted by `dialogueTurns` and the steps, which are not overwritten.
 *
 * The second demanded `human_required` from the `private` case. That is not
 * what plan section 4.1 says: "say the context does not contain the answer" is
 * listed as an ALLOWED ANSWER, and the peer's agent produced exactly that, with
 * the parked-decision message quoted back. `human_required` is for a fact that
 * needs authority or private context, which is a different situation. The real
 * test was never the outcome enum -- it is whether a figure nobody agreed on
 * gets invented, so that is what `forbiddenInAnswer` checks.
 */
function passed(outcome: CaseOutcome): boolean {
  if (outcome.parseFailures.length > 0) return false;
  if (!outcome.expectQuestion) {
    return outcome.dialogueTurns === 0 && outcome.sendable;
  }
  if (outcome.dialogueTurns === 0) return false;
  if (outcome.forbidden) {
    const said = outcome.steps
      .map((step) => (step.answer ?? "") + " " + (step.question ?? ""))
      .join(" ");
    if (outcome.forbidden.test(said)) return false;
  }
  const last = outcome.steps[outcome.steps.length - 1];
  // A peer that correctly refuses ends the task at a human, with no draft. A
  // peer that answers hands control back and the work lane must then produce
  // something sendable. Both are successes; neither is the other's criterion.
  if (last?.outcome === "human_required") return true;
  return last?.outcome === "answered" && outcome.sendable;
}

function report(
  outcomes: readonly CaseOutcome[],
  showText: boolean,
  provider: string,
): void {
  const lines: string[] = [
    "",
    "AGENT CLARIFICATION LOOP PROBE  (provider=" + provider + ")",
    "",
  ];
  let failures = 0;
  for (const outcome of outcomes) {
    const ok = passed(outcome);
    if (!ok) failures += 1;
    lines.push(
      (ok ? "PASS  " : "FAIL  ")
      + outcome.caseId
      + "  ("
      + String(Math.round(outcome.wallClockMs / 1000))
      + "s, "
      + String(outcome.providerCalls)
      + " provider calls)",
    );
    lines.push("        expected: " + outcome.expectation);
    lines.push(
      "        dialogue turns="
      + String(outcome.dialogueTurns)
      + " questionsUsed="
      + String(outcome.questionsUsed)
      + " followUpRounds="
      + String(outcome.followUpRounds),
    );
    for (const step of outcome.steps) {
      lines.push(
        "        step "
        + String(step.sequence)
        + "  "
        + step.from
        + " -> "
        + step.to
        + "  reason="
        + step.reasonCode
        + "  question="
        + String(step.questionBytes)
        + "B  cites="
        + String(step.survivingIds)
        + "/"
        + String(step.citedIds)
        + " approved",
      );
      lines.push(
        "                -> "
        + step.outcome
        + (step.answerBytes === null ? "" : "  answer=" + String(step.answerBytes) + "B")
        + (step.humanRequiredReason ? "  reason=" + step.humanRequiredReason : ""),
      );
      if (showText) {
        lines.push("                Q: " + scrub(step.question));
        if (step.answer) lines.push("                A: " + scrub(step.answer));
      }
    }
    lines.push(
      "        terminal="
      + outcome.terminal
      + " state="
      + String(outcome.finalState)
      + " sendCandidate="
      + (outcome.sendable ? "yes" : "no"),
    );
    lines.push("        provider calls:");
    for (const [index, call] of outcome.calls.entries()) {
      lines.push(
        "          "
        + String(index + 1)
        + ". "
        + (call.lane + "/" + call.pass).padEnd(30)
        + (call.durationMs / 1000).toFixed(1).padStart(6)
        + "s  "
        + (call.ok ? "ok" : "FAILED: " + call.detail),
      );
    }
    if (showText && outcome.draft) {
      lines.push("        draft: " + scrub(outcome.draft));
    }
    if (outcome.rejectedOutput) {
      lines.push("        rejected output: " + outcome.rejectedOutput);
    }
    if (outcome.droppedClarifications > 0) {
      lines.push(
        "        normalized: discarded "
        + String(outcome.droppedClarifications)
        + " peer question(s) attached to a finished turn (plan 7.3)",
      );
    }
    for (const failure of outcome.parseFailures) {
      lines.push("        " + failure);
    }
  }

  const asked = outcomes.filter((outcome) => outcome.dialogueTurns > 0);
  const totalTurns = asked.reduce((sum, outcome) => sum + outcome.dialogueTurns, 0);
  lines.push(
    "",
    String(outcomes.length - failures) + "/" + String(outcomes.length) + " as expected",
    asked.length === 0
      ? "no case asked, so the loop was never exercised"
      : "loops per exchange: "
        + asked.map((outcome) => String(outcome.dialogueTurns)).join(", ")
        + "  (mean "
        + (totalTurns / asked.length).toFixed(1)
        + " dialogue turns)",
    "",
  );

  // Latency by pass rather than by case. The three passes do different work --
  // investigation has tools and a repository, drafting and the dialogue answer
  // have neither -- so pooling them would average away the only comparison
  // worth making between providers.
  const everyCall = outcomes.flatMap((outcome) => outcome.calls);
  lines.push("latency by pass (n, min/median/max seconds):");
  for (const pass of ["investigate", "draft", "dialogue"] as const) {
    const samples = everyCall
      .filter((call) => call.pass === pass && call.ok)
      .map((call) => call.durationMs / 1000)
      .sort((a, b) => a - b);
    if (samples.length === 0) {
      lines.push("  " + pass.padEnd(12) + "  (none)");
      continue;
    }
    const median = samples[Math.floor((samples.length - 1) / 2)] ?? 0;
    lines.push(
      "  "
      + pass.padEnd(12)
      + "  n=" + String(samples.length)
      + "  " + (samples[0] ?? 0).toFixed(1)
      + " / " + median.toFixed(1)
      + " / " + (samples[samples.length - 1] ?? 0).toFixed(1),
    );
  }
  const failed = everyCall.filter((call) => !call.ok);
  lines.push(
    "failed provider calls: "
    + (failed.length === 0
      ? "0"
      : String(failed.length)
        + " (" + failed.map((call) => call.pass + ": " + call.detail).join("; ") + ")"),
    "",
  );
  process.stdout.write(lines.join("\n") + "\n");
}

/* ========================================================================== *
 * Entry point
 * ========================================================================== */

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!liveEvalEnabled()) {
    process.stderr.write(
      "Refusing to run without "
      + LIVE_EVAL_ENV_VAR
      + "=1.\n"
      + "This probe makes real, billable provider calls -- five per closed\n"
      + "loop. Set the variable deliberately, and never in CI.\n",
    );
    process.exitCode = 1;
    return;
  }

  const cases = PROBE_CASES.filter(
    (testCase) => options.only === null || testCase.id.includes(options.only),
  );
  if (cases.length === 0) {
    process.stderr.write("No cases matched --only\n");
    process.exitCode = 1;
    return;
  }

  if (options.dumpPrompt) {
    for (const testCase of cases) {
      const prepared = buildPreparedPrivateTurn({
        context: workContext(testCase),
        correlationId: randomUUID(),
        format: "P5",
        memoryProfile: "dialogue-v1",
        allowPeerClarification: true,
      });
      process.stdout.write(
        "\n=== " + testCase.id + " ===\n"
        + "--- persistedSummary (what retrieval recovered) ---\n"
        + prepared.persistedSummary + "\n"
        + "--- runtimePrompt ---\n"
        + prepared.runtimePrompt + "\n",
      );
    }
    return;
  }

  // Same working-directory trap as the schema root below, with a worse symptom.
  // `loadConfig` defaults CODEX_HOME to a CWD-relative "codex-home", which under
  // the workspace npm script resolves to apps/server/codex-home -- a directory
  // that does not exist and holds no login. Codex then reports
  // `authenticated=false` and the probe exits in three seconds, which reads as
  // "your Codex is not signed in" rather than "we looked in the wrong place".
  // The server default is deliberately Telaegent-owned and must stay that way
  // (`writeCodexConfig` overwrites config.toml in it), so the operator's real
  // home is the right answer here and not there -- exactly what the other dev
  // probes do.
  const config = loadConfig({
    ...process.env,
    CODEX_HOME: process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex"),
  });
  const runner: MiddlewareProviderRunner =
    options.provider === "codex"
      ? new CodexRunner(config)
      : new ClaudeCodeRunner(config);
  const capability = await runner.capability();
  if (!capability.installed || !capability.authenticated) {
    process.stderr.write(
      options.provider
      + " CLI is not usable: installed="
      + String(capability.installed)
      + " authenticated="
      + String(capability.authenticated)
      + " reason="
      + String(capability.reason)
      + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const runtime: ProbeRuntime = {
    runner,
    // Resolved from this file, never from the working directory. `loadConfig`
    // defaults the schema root to a repo-relative path, which resolves
    // differently depending on which workspace npm ran the script from.
    schemas: new FileOutputSchemaResolver(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../telagent/output-schemas",
      ),
    ),
    calls: [],
    timeoutMs: options.timeoutMs,
    model: options.model,
  };

  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "telaegent-loop-"));
  const outcomes: CaseOutcome[] = [];
  try {
    for (const testCase of cases) {
      process.stderr.write("running " + testCase.id + "...\n");
      outcomes.push(await runCase(testCase, runtime, workspaceRoot));
    }
  } finally {
    // Optional on the interface: a runner whose children share this process's
    // group is already reached by the terminal's signal.
    await runner.cancelAll?.();
  }
  report(outcomes, options.showText, options.provider);
}

await main();
