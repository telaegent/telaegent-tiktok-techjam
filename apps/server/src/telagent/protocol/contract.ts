/**
 * AGENT PROTOCOL CONTRACT — workstream: agent-to-agent protocol R&D (hien.md).
 *
 * This file is the frozen answer to hien.md §16 questions 1, 5, 6, 7 and 10.
 * It is deliberately the only place the protocol's vocabulary is declared, so
 * that Duy's UI states, Phuong's runtime result type and Khoa's authorization
 * checks all derive from one union rather than three hand-typed copies.
 *
 * Read the invariants at the bottom before changing anything here. They are the
 * properties the security suite asserts; a change that weakens one of them is a
 * product decision, not a refactor.
 *
 * Relationship to the existing middleware contract
 * ------------------------------------------------
 * `../../runtime-contract.ts` describes how a provider process is launched.
 * This file describes what is *said* to it and what shape the answer must take.
 * The two meet in `ProtocolTurnRequest.runtime`, which is deliberately a subset
 * of Phuong's `MiddlewareRunRequest` — the protocol layer decides prompt and
 * schema, never workspace paths or sandbox flags. Those come from the backend
 * runtime binding, because hien.md §9 requires that a remote collaborator can
 * never influence them.
 */

import { TELAGENT_LIMITS } from "../constants.js";

/* ========================================================================== *
 * 1. The two agent jobs  (hien.md §3)
 * ========================================================================== */

/**
 * Sender and recipient are separate prompts, separate schemas and separate
 * test suites. hien.md §3 is explicit that they must not share a template: the
 * sender is negotiating with its *own* owner about what to ask, while the
 * recipient is answering a question that already crossed the trust boundary.
 * Collapsing them produces an agent that asks the collaborator clarifying
 * questions, which is the single most confusing failure mode observed.
 */
export const PROTOCOL_ROLES = ["sender", "recipient"] as const;
export type ProtocolRole = (typeof PROTOCOL_ROLES)[number];

/* ========================================================================== *
 * 2. Turn state  (hien.md §8, phuong.md §8.1, duy.md §9)
 * ========================================================================== */

/**
 * The state a private agent turn ends in.
 *
 * These three values are the whole vocabulary. Duy's private-room UI renders
 * one panel per value; Phuong's orchestrator transitions on them. "Thinking"
 * and "Error" exist in duy.md §9 as UI states but are NOT protocol states —
 * they describe the runtime, not the model's answer, and modelling them here
 * would let a model claim it is still thinking in order to avoid answering.
 */
export const TURN_STATES = ["needs_clarification", "ready", "blocked"] as const;
export type TurnState = (typeof TURN_STATES)[number];

/* ========================================================================== *
 * 3. Risk flags
 * ========================================================================== */

/**
 * What the model believes is risky about this turn.
 *
 * Critical semantics, asserted by `security.test.ts`: a risk flag is a *hint*,
 * never a permission. An absent `secret_content` flag does not make output
 * sendable, and a present one does not by itself block it. The deterministic
 * guards in `guards.ts` decide; these flags exist so the UI can explain the
 * decision and so evaluation can measure whether a model noticed the risk at
 * all (hien.md §5, "Secret safety" and "Permission semantics").
 */
export const RISK_FLAGS = [
  /** The incoming or outgoing text asks for credential material. */
  "secret_request",
  /** The draft itself appears to contain credential material. */
  "secret_content",
  /** The request reaches outside the selected project. */
  "scope_violation",
  /** Repository text or a collaborator message tried to issue instructions. */
  "injection_detected",
  /** The model tried to send, deliver or transmit without human approval. */
  "auto_send_attempt",
  /** The model asserted an authorization it does not have. */
  "permission_escalation",
  /** A path or name belonging to another project or repository was referenced. */
  "cross_project_reference",
  /** The draft would disclose substantially more source than the question needs. */
  "oversized_disclosure",
  /** The owner's intent could not be determined without asking. */
  "ambiguous_request",
] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

/* ========================================================================== *
 * 4. Model output shapes
 * ========================================================================== */

/**
 * What the sender-side private agent returns.
 *
 * `sendCandidate` is the ONLY field that may ever cross the trust boundary.
 * Everything else is private to the owner. That separation is the reason the
 * schema has a dedicated field rather than asking the model to mark part of a
 * prose answer: a prose marker is a parsing problem, and a parsing problem at a
 * trust boundary is a vulnerability.
 */
export interface SenderTurnOutput {
  state: TurnState;
  /** Shown privately to the owner in the private room. Never transmitted. */
  assistantMessage: string;
  /** Non-null if and only if `state === "ready"`. See invariant I1. */
  sendCandidate: string | null;
  riskFlags: RiskFlag[];
  /**
   * Workspace-relative POSIX paths the model claims it consulted.
   *
   * Untrusted and advisory. The backend does not grant access from this list,
   * does not attach commits to it, and treats a path outside the workspace as
   * a `scope_violation` audit event rather than an error. It exists so
   * evaluation can measure grounding (hien.md §5) and so the UI can show the
   * owner what their own agent looked at.
   */
  referencedPaths: string[];
}

/**
 * What the recipient-side private agent returns.
 *
 * Note what is absent: no commit, no hash, no session identifier, no file
 * contents keyed by digest. hien.md §8 asks "are source refs reliable if
 * model-provided?" — the answer this contract encodes is no. The model names
 * paths; the backend attaches the commit and digest it computed itself. A
 * model-supplied commit is unverifiable by construction, and accepting one
 * would let a poisoned repository file dictate the provenance shown to the
 * other developer.
 */
export interface RecipientTurnOutput {
  state: TurnState;
  /** Shown privately to the recipient. Never transmitted. */
  privateSummary: string;
  /** Non-null if and only if `state === "ready"`. See invariant I1. */
  sendCandidate: string | null;
  riskFlags: RiskFlag[];
  /** Paths only. Provenance is attached by the backend, never by the model. */
  sourcePaths: string[];
}

export type ProtocolTurnOutput = SenderTurnOutput | RecipientTurnOutput;

/* ========================================================================== *
 * 5. Backend-attached provenance
 * ========================================================================== */

/**
 * The trusted half of a source reference. Produced by `git-helper.ts` from the
 * actual checkout, never by a model. Pairing this with the model's path list
 * is what makes "Justin's Claude — branch feat/auth, commit 81ad2e" in duy.md
 * §15 a statement Telaegent can stand behind.
 */
export interface TrustedSourceRef {
  /** Workspace-relative POSIX path, already normalised by context-policy. */
  path: string;
  /** Commit the workspace was on when the turn ran. */
  commit: string;
  /** SHA-256 of the file at that commit. */
  digest: string;
}

/* ========================================================================== *
 * 6. Turn input
 * ========================================================================== */

/** One approved message already visible to both sides. */
export interface SharedTurn {
  /** Stable id, used to prove ordering was preserved under compaction. */
  id: string;
  /** Display name of the human whose side sent it. */
  author: string;
  /** Whether the text was written by the human or drafted by their agent. */
  origin: "human" | "agent";
  text: string;
  /** ISO-8601. */
  at: string;
}

/**
 * Project facts the backend knows to be true. Never model-supplied and never
 * collaborator-supplied — phuong.md §7 forbids a remote party from influencing
 * any of these fields, because they determine which files an agent can reach.
 */
export interface ProjectFacts {
  /** `owner/name` as GitHub reports it. */
  repositoryFullName: string;
  /** Stable numeric GitHub repository id — the real scope key (khoa.md §3). */
  githubRepositoryId: string;
  branch: string;
  commit: string;
  /** Display name of the human this agent represents. */
  ownerName: string;
  /** Display name of the human on the other side. */
  collaboratorName: string;
}

export interface SenderTurnInput {
  role: "sender";
  facts: ProjectFacts;
  /** The owner's rough, unsent text. Trusted as intent, not as instruction. */
  ownerInput: string;
  /** Prior private clarification turns in this drafting session. */
  privateTurns: { speaker: "owner" | "agent"; text: string }[];
  /** Approved shared history, already selected by the memory strategy. */
  sharedHistory: SharedTurn[];
  /** Compact durable summary, when the memory strategy provides one. */
  projectSummary?: string | undefined;
}

export interface RecipientTurnInput {
  role: "recipient";
  facts: ProjectFacts;
  /**
   * The approved message from the collaborator.
   *
   * This is the single most dangerous string in the system: it is authored by
   * another person's agent and has already crossed the trust boundary. Every
   * format renderer must place it inside an explicit untrusted-data envelope,
   * and `security.test.ts` asserts that it does.
   */
  incomingMessage: string;
  privateTurns: { speaker: "owner" | "agent"; text: string }[];
  sharedHistory: SharedTurn[];
  projectSummary?: string | undefined;
}

export type ProtocolTurnInput = SenderTurnInput | RecipientTurnInput;

/* ========================================================================== *
 * 7. Format and memory strategy identifiers  (hien.md §7 and §15)
 * ========================================================================== */

/** The five context formats compared in the protocol report. */
export const PROTOCOL_FORMATS = ["P1", "P2", "P3", "P4", "P5"] as const;
export type ProtocolFormatId = (typeof PROTOCOL_FORMATS)[number];

/** The five memory strategies compared for Phuong. */
export const MEMORY_STRATEGIES = ["M1", "M2", "M3", "M4", "M5"] as const;
export type MemoryStrategyId = (typeof MEMORY_STRATEGIES)[number];

/**
 * A rendered prompt plus the accounting evaluation needs. `approximateTokens`
 * is a character-quarter estimate, not a tokenizer result: hien.md §5 asks for
 * relative context efficiency between formats, and a consistent cheap estimate
 * compares formats correctly without adding a tokenizer dependency that would
 * differ per provider anyway.
 */
export interface RenderedPrompt {
  format: ProtocolFormatId;
  role: ProtocolRole;
  /** Instruction block. Stable across cases; safe to log. */
  system: string;
  /** Case-specific payload. May quote repository text; never logged raw. */
  user: string;
  characterCount: number;
  approximateTokens: number;
}

/* ========================================================================== *
 * 8. Limits
 * ========================================================================== */

/**
 * Protocol-layer limits. Deliberately derived from `TELAGENT_LIMITS` where an
 * equivalent already exists, so there is one number per concept in the product
 * (finding C8 in the earlier cross-file review: never retype a limit).
 */
export const PROTOCOL_LIMITS = Object.freeze({
  /** Longest message that may cross the boundary. */
  maxSendCandidateChars: TELAGENT_LIMITS.summaryLength * 2,
  /** Longest private message shown to the owner. */
  maxPrivateMessageChars: TELAGENT_LIMITS.taskLength,
  /** Paths a model may claim per turn. Beyond this the turn is oversized. */
  maxReferencedPaths: TELAGENT_LIMITS.sourceRefs,
  /** Shared turns injected by the recommended memory strategy (M4). */
  recentSharedTurns: 8,
  /** Compact durable project summary budget. */
  maxProjectSummaryChars: TELAGENT_LIMITS.summaryLength,
  /** Clarification turns before the private room must resolve (duy.md §9). */
  maxClarificationTurns: 3,
  /** Above this a single draft is flagged `oversized_disclosure`. */
  oversizedDisclosureChars: 4_000,
  /**
   * Approved file characters one turn may carry in its prompt (build plan
   * 8.6). A second clamp: the owner's connector already bounded the read.
   */
  maxDeliveredResourceChars: 200_000,
});

/* ========================================================================== *
 * 9. Invariants
 * ========================================================================== *
 *
 * Each is asserted by name in protocol.test.ts or security.test.ts. If a change
 * makes one of these false, the change is wrong or the product decision behind
 * it must be made explicitly by the team.
 *
 *  I1  state === "ready"  <=>  sendCandidate is a non-empty string.
 *  I2  state !== "ready"   =>  sendCandidate === null.
 *  I3  state === "blocked" =>  riskFlags is non-empty.
 *  I4  Model output carries no commit, digest, session id or absolute path.
 *      The parser rejects unknown keys rather than dropping them, so a model
 *      that invents `"commit"` fails loudly instead of being silently trusted.
 *  I5  A sendCandidate is a *candidate*. It becomes a shared message only after
 *      deterministic guards pass AND a human presses Send. Neither the model's
 *      state nor its risk flags can substitute for either.
 *  I6  Every renderer marks collaborator-authored and repository-authored text
 *      as untrusted data. Instructions found inside them are reported, never
 *      obeyed.
 */
