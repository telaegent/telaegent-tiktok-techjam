/**
 * RUNTIME ADAPTER — the join between the protocol layer and the backend.
 *
 * Responsibility chain, as agreed with Khoa:
 *
 *   protocol layer      prepares prompt and structured-output requirements
 *         ↓
 *   authorization layer selects the authorized runtime and execution policy
 *         ↓
 *   runtime layer       manages provider sessions, execution and progress
 *
 * This file sits at the top of that chain and deliberately produces *content
 * only*. It cannot name a workspace, a runtime binding, a sandbox mode, a
 * network policy or a turn budget, because every one of those either selects
 * infrastructure or controls security and cost. They are supplied by
 * `AuthorizedPrivateRuntimeTurnStarter` after it re-authorizes, and the type it
 * accepts — `BackendPreparedPrivateTurn` — omits them, so this file *cannot*
 * express them even by accident.
 *
 * An earlier version built a whole `ManagedAgentTurnRequest` including
 * `workspacePath` and `sandboxMode`. It set safe values, but the safety was a
 * property of my care rather than of the type, and the protocol layer had no
 * business knowing where a workspace lives. Producing the narrower type is what
 * makes the boundary real rather than conventional.
 *
 * Dependency direction
 * --------------------
 * Everything imported from outside `protocol/` is `import type`. This file
 * constructs no runtime object, calls no runner, touches no filesystem.
 */

import type { BackendPreparedPrivateTurn } from "../../authorization/authorized-private-runtime-turn.js";
import type {
  ManagedAgentTurnRequest,
  ProviderSessionHydrator,
  ProviderSessionScope,
} from "../../provider-session-manager.js";
import type { RunPurpose, SessionMode } from "../../runtime-contract.js";

import {
  PROTOCOL_LIMITS,
  type ProjectFacts,
  type ProtocolFormatId,
  type ProtocolRole,
  type ProtocolTurnInput,
  type RecipientTurnInput,
  type SenderTurnInput,
  type SharedTurn,
} from "./contract.js";
import { getFormat } from "./formats.js";
import { rehydrationContext } from "./memory.js";

/* ========================================================================== *
 * Names the runtime uses
 * ========================================================================== */

/**
 * Schema file names, matching `FileOutputSchemaResolver`'s convention and the
 * starter's `outputSchemaNamePattern`.
 *
 * The files are committed under `output-schemas/` because the resolver reads
 * from disk, but they are generated from the same Zod objects the parser
 * enforces — `protocol.test.ts` fails if they drift.
 */
export const PROTOCOL_OUTPUT_SCHEMAS: Readonly<Record<ProtocolRole, string>> =
  Object.freeze({
    sender: "sender-turn.schema.json",
    recipient: "recipient-turn.schema.json",
  });

/** `RunPurpose` values for the two agent jobs. */
export const PROTOCOL_PURPOSES: Readonly<Record<ProtocolRole, RunPurpose>> =
  Object.freeze({
    sender: "sender_draft",
    recipient: "recipient_answer",
  });

/* ========================================================================== *
 * Hydration failures
 * ========================================================================== */

export type ProtocolHydrationCode =
  /** Telaegent's own conversation could not be loaded. Transient. */
  | "DURABLE_CONTEXT_UNAVAILABLE"
  /** The loaded context belongs to a different repository than the scope. */
  | "DURABLE_CONTEXT_SCOPE_MISMATCH"
  /** The loaded context is for a different agent job than the turn. */
  | "DURABLE_CONTEXT_PURPOSE_MISMATCH";

/**
 * Deliberately not a `RuntimeProviderError`.
 *
 * Each of these is an invariant violation on our side of the boundary, not a
 * provider problem. Dressing one as a runtime failure would send whoever reads
 * the audit trail looking at Claude or Codex when the bug is in our own wiring.
 *
 * The message carries no values — no paths, no prompts, no repository ids —
 * following the same discipline as `InvalidPrivateRuntimeTurnError`. The code
 * says what happened; the audit hook carries the scope to anyone entitled to
 * see it.
 */
export class ProtocolHydrationError extends Error {
  public override readonly name = "ProtocolHydrationError";

  constructor(
    public readonly code: ProtocolHydrationCode,
    /** Whether retrying the same turn could succeed. */
    public readonly retryable: boolean,
  ) {
    super("Protocol context could not be prepared");
  }
}

/* ========================================================================== *
 * Durable context
 * ========================================================================== */

/**
 * Everything Telaegent's own database knows about a conversation.
 *
 * Every field must be reconstructible from durable rows with no provider
 * involvement — that is the entire claim being made. If a field here could only
 * come from a live provider session, the recovery story is circular.
 */
export interface DurableConversationContext {
  role: ProtocolRole;
  facts: ProjectFacts;
  /** Approved shared messages, oldest first. */
  sharedHistory: SharedTurn[];
  /** Short factual statements about the project, for the compact summary. */
  projectFacts: string[];
  /** Private clarification turns for this drafting session, if any. */
  privateTurns?: { speaker: "owner" | "agent"; text: string }[];
  /** The owner's rough input, for a sender turn. */
  ownerInput?: string;
  /** The approved collaborator message, for a recipient turn. */
  incomingMessage?: string;
}

export type DurableContextLoader = (
  scope: ProviderSessionScope,
) => Promise<DurableConversationContext | null>;

/* ========================================================================== *
 * Turn input assembly
 * ========================================================================== */

/**
 * Builds the protocol turn input from durable context.
 *
 * `facts` comes from the loader and from nowhere else — never from the request,
 * never from a message. Repository id, branch and commit decide which files an
 * agent can reach, so a remote collaborator must not be able to influence them.
 */
export function toTurnInput(
  context: DurableConversationContext,
  memory = rehydrationContext(context.sharedHistory, context.projectFacts),
): ProtocolTurnInput {
  const shared = {
    facts: context.facts,
    privateTurns: context.privateTurns ?? [],
    sharedHistory: memory.turns,
    projectSummary: memory.summary,
  };

  if (context.role === "sender") {
    const input: SenderTurnInput = {
      role: "sender",
      ownerInput: context.ownerInput ?? "",
      ...shared,
    };
    return input;
  }

  const input: RecipientTurnInput = {
    role: "recipient",
    incomingMessage: context.incomingMessage ?? "",
    ...shared,
  };
  return input;
}

function renderTurn(
  context: DurableConversationContext,
  format: ProtocolFormatId,
): { runtimePrompt: string; persistedSummary: string } {
  const memory = rehydrationContext(context.sharedHistory, context.projectFacts);
  const rendered = getFormat(format).render(toTurnInput(context, memory));

  // `runtimePrompt` carries the full rendered turn; `persistedSummary` carries
  // the compact durable summary alone. They are separate fields in the runtime
  // contract, so a provider adapter can put the summary somewhere cheaper than
  // the prompt if it is able to.
  return {
    runtimePrompt: rendered.system + "\n\n---\n\n" + rendered.user,
    persistedSummary: (memory.summary ?? "").slice(
      0,
      PROTOCOL_LIMITS.maxProjectSummaryChars,
    ),
  };
}

/* ========================================================================== *
 * Building a prepared turn
 * ========================================================================== */

export interface BuildPreparedTurnOptions {
  context: DurableConversationContext;
  correlationId: string;
  format?: ProtocolFormatId;
  /** Defaults to `continue`, letting the session manager resume when it can. */
  sessionMode?: SessionMode;
}

/**
 * Produces the content half of a private turn.
 *
 * What this returns is deliberately not runnable on its own: it has no
 * workspace and no execution policy, so it must pass through
 * `AuthorizedPrivateRuntimeTurnStarter.start()` to become a real request. That
 * is the point. There is no path from here to a provider that skips
 * authorization, because the value produced here is missing the fields a
 * provider run requires.
 */
export function buildPreparedPrivateTurn(
  options: BuildPreparedTurnOptions,
): BackendPreparedPrivateTurn {
  const role = options.context.role;
  const { runtimePrompt, persistedSummary } = renderTurn(
    options.context,
    options.format ?? "P5",
  );

  return {
    purpose: role === "sender" ? "sender_draft" : "recipient_answer",
    runtimePrompt,
    persistedSummary,
    outputSchemaName: PROTOCOL_OUTPUT_SCHEMAS[role],
    correlationId: options.correlationId,
    ...(options.sessionMode ? { sessionMode: options.sessionMode } : {}),
  };
}

/* ========================================================================== *
 * The hydrator
 * ========================================================================== */

export interface ProtocolHydratorOptions {
  load: DurableContextLoader;
  /**
   * Context format to render with. P5 by default: it is the only format whose
   * context Telaegent can rebuild from its own database, which is exactly the
   * situation a hydrator is called in. On the safety corpus P3 and P5 scored
   * identically, so this default costs nothing measured.
   */
  format?: ProtocolFormatId;
  /**
   * Called immediately before a hydration failure is thrown. Khoa's audit layer
   * is the natural consumer: the error itself is value-free by design, so this
   * is where the scope reaches anyone entitled to see it.
   */
  onHydrationRejected?: (
    scope: ProviderSessionScope,
    code: ProtocolHydrationCode,
  ) => void;
}

/**
 * Builds a `ProviderSessionHydrator`.
 *
 * When it runs
 * ------------
 * `ProviderSessionManager` calls this only on *recovery* — a `continue` turn
 * whose session is gone, or one that failed `RUNTIME_SESSION_NOT_FOUND`. An
 * explicitly `fresh` turn does not hydrate, because that is the caller starting
 * clean rather than the system recovering from loss.
 *
 * Why it fails closed
 * -------------------
 * An earlier version returned the request unchanged when context could not be
 * loaded, reasoning that a hydrator which throws turns recoverable session loss
 * into a failed turn. That reasoning was wrong, and Khoa was right to push back.
 *
 * On the recovery path the request being passed through is the *original* one,
 * and for a `continue` turn its context lived in the provider session that just
 * disappeared — so `runtimePrompt` is empty. Returning it unchanged does not
 * degrade gracefully; it runs the agent with no context at all, producing a
 * confident, ungrounded answer that a human may well approve. A visible failure
 * the user can retry is strictly better than a plausible answer built on
 * nothing.
 *
 * The starter's validator agrees independently: it rejects an empty
 * `runtimePrompt` outright.
 *
 *   session missing + durable context available   → rebuild and continue
 *   session missing + durable context unavailable → safe retryable failure
 */
export function createProtocolHydrator(
  options: ProtocolHydratorOptions,
): ProviderSessionHydrator {
  const formatId = options.format ?? "P5";

  const reject = (
    scope: ProviderSessionScope,
    code: ProtocolHydrationCode,
    retryable: boolean,
  ): never => {
    options.onHydrationRejected?.(scope, code);
    throw new ProtocolHydrationError(code, retryable);
  };

  return async (
    scope: ProviderSessionScope,
    request: ManagedAgentTurnRequest,
  ): Promise<ManagedAgentTurnRequest> => {
    const context = await options.load(scope);
    if (context === null) {
      // Transient by assumption: the store was unreachable, or the conversation
      // has not been written yet. Retrying the same turn can succeed.
      return reject(scope, "DURABLE_CONTEXT_UNAVAILABLE", true);
    }

    // The scope and the context it loaded must agree on which repository this
    // is. They arrive from different places — the scope from the session
    // manager, the facts from the backend's own store — and a mismatch means
    // one conversation is about to be hydrated with another project's history.
    // Nothing downstream could detect that, so it stops here.
    //
    // Only checkable because the scope key is `githubRepositoryId` on both
    // sides; against a free-form repository id there was no common identifier.
    if (context.facts.githubRepositoryId !== scope.githubRepositoryId) {
      return reject(scope, "DURABLE_CONTEXT_SCOPE_MISMATCH", false);
    }

    // And on which agent job this is. A recipient's context rendered into a
    // sender turn would put the collaborator's message where the owner's rough
    // input belongs — the two roles have different trust properties, and
    // swapping them is exactly the confusion the separate templates exist to
    // prevent.
    if (PROTOCOL_PURPOSES[context.role] !== request.purpose) {
      return reject(scope, "DURABLE_CONTEXT_PURPOSE_MISMATCH", false);
    }

    const { runtimePrompt, persistedSummary } = renderTurn(context, formatId);

    // Only the content fields are replaced. `workspacePath`, `agentId`,
    // `sandboxMode`, `networkMode` and `maxTurns` were set by the starter after
    // it authorized, and the hydrator has no business revising them.
    return { ...request, runtimePrompt, persistedSummary };
  };
}
