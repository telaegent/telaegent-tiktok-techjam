/**
 * RUNTIME ADAPTER — the join between the protocol layer and Phuong's runtime.
 *
 * Two pieces of work were done independently and turned out to describe the
 * same thing from opposite sides:
 *
 *   `provider-session-manager.ts` says provider sessions are an optimisation
 *   only, and takes a `ProviderSessionHydrator` to rebuild agent context from
 *   "canonical Telaegent conversation context" when a session is missing.
 *
 *   `memory.ts` says the same thing as a testable property — every strategy
 *   but M1 carries `rebuildableFromTelaegentAlone: true` — and exposes
 *   `rehydrationContext()` to do the rebuilding.
 *
 * One is the socket, the other is the plug. This file connects them, and until
 * it existed neither side imported the other: the runtime had a hydrator hook
 * with no hydrator, and the protocol layer had a rehydration function nothing
 * called.
 *
 * Dependency direction, deliberately
 * ----------------------------------
 * Everything imported from outside `protocol/` here is `import type`. This file
 * constructs no runtime object, calls no runner, and touches no filesystem — it
 * is a pure translation between two type vocabularies. That keeps the rule the
 * protocol layer has held since the start (nothing here reaches a provider
 * except through an injected port) true, and it means Phuong can wire this in
 * without inheriting a dependency he did not ask for.
 *
 * What this file does NOT do
 * --------------------------
 * It does not choose a session mode, create or delete a session, or set
 * `provider` / `sessionId`. `ManagedAgentTurnRequest` omits exactly those three
 * fields because the session manager owns them, and the adapter respects that
 * boundary rather than reaching around it. A hydrator that quietly forced
 * `sessionMode: "fresh"` would defeat the manager's whole recovery sequence.
 */

import type {
  ManagedAgentTurnRequest,
  ProviderSessionHydrator,
  ProviderSessionScope,
} from "../../provider-session-manager.js";
import type { RunPurpose } from "../../runtime-contract.js";

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
 * Schema file names, matching `FileOutputSchemaResolver`'s convention.
 *
 * The files are committed under `output-schemas/` because the resolver reads
 * from disk, but they are generated from the same Zod objects the parser
 * enforces — `schemas.test.ts` fails if the committed file and the generated
 * document drift apart. A hand-maintained `.json` beside a Zod schema is a bug
 * with a several-week fuse; a committed-and-asserted one is not.
 */
export const PROTOCOL_OUTPUT_SCHEMAS: Readonly<Record<ProtocolRole, string>> =
  Object.freeze({
    sender: "sender-turn.schema.json",
    recipient: "recipient-turn.schema.json",
  });

/**
 * `RunPurpose` values for the two agent jobs.
 *
 * Both already exist in `runtime-contract.ts` — Phuong added `sender_draft` and
 * `recipient_answer` before this adapter was written, which is why the two
 * sides fit without either changing a type.
 */
export const PROTOCOL_PURPOSES: Readonly<Record<ProtocolRole, RunPurpose>> =
  Object.freeze({
    sender: "sender_draft",
    recipient: "recipient_answer",
  });

/* ========================================================================== *
 * Durable context
 * ========================================================================== */

/**
 * Everything Telaegent's own database knows about a conversation.
 *
 * This is the input to rehydration, and every field must be reconstructible
 * from durable rows with no provider involvement — that is the entire claim
 * being made. If a field here could only come from a live provider session, the
 * recovery story is circular.
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

/**
 * Loads durable context for a scope. Supplied by the backend, because only it
 * knows how conversations are stored.
 */
export type DurableContextLoader = (
  scope: ProviderSessionScope,
) => Promise<DurableConversationContext | null>;

/* ========================================================================== *
 * Turn input assembly
 * ========================================================================== */

/**
 * Builds the protocol turn input from durable context.
 *
 * Note which fields are *not* taken from anywhere else: `facts` comes from the
 * loader, never from the request, and never from a message. Repository id,
 * branch and commit decide which files an agent can reach, so a remote
 * collaborator must not be able to influence them — that is `phuong.md` §7 and
 * it is the reason this function takes no untrusted argument at all.
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

/* ========================================================================== *
 * The hydrator
 * ========================================================================== */

export interface ProtocolHydratorOptions {
  load: DurableContextLoader;
  /**
   * Context format to render with. P5 by default, and the reason is specific to
   * this file: P5 is the only format whose context Telaegent can rebuild from
   * its own database, which is exactly the situation a hydrator is called in.
   * On the safety corpus P3 and P5 scored identically, so this default costs
   * nothing measured and buys the property that matters here.
   */
  format?: ProtocolFormatId;
  /**
   * Called when the loaded context belongs to a different repository than the
   * scope asked for. Reported rather than thrown, for the reason in the body:
   * a hydrator that throws turns recoverable session loss into a failed turn.
   * Khoa's audit layer is the natural home for it.
   */
  onScopeMismatch?: (scope: ProviderSessionScope) => void;
}

/**
 * Builds a `ProviderSessionHydrator`.
 *
 * When it runs, and when it does not
 * ----------------------------------
 * `ProviderSessionManager` calls this only on *recovery* — a `continue` turn
 * whose session is gone, or one that failed with `RUNTIME_SESSION_NOT_FOUND`.
 * An explicitly requested `fresh` turn does not hydrate, because that is the
 * caller deliberately starting clean rather than the system recovering from
 * loss. Reading that distinction out of `startFresh(..., needsHydration)` is
 * what makes this correct rather than merely plausible, and it is worth
 * preserving if either side is refactored.
 *
 * Failure behaviour
 * -----------------
 * If durable context cannot be loaded, the request is returned unchanged rather
 * than throwing. A hydrator that throws turns "we lost the provider session"
 * into "the turn failed", which is precisely the degradation the whole design
 * exists to avoid: the user should get a longer prompt, not an error.
 */
export function createProtocolHydrator(
  options: ProtocolHydratorOptions,
): ProviderSessionHydrator {
  const formatId = options.format ?? "P5";

  return async (
    scope: ProviderSessionScope,
    request: ManagedAgentTurnRequest,
  ): Promise<ManagedAgentTurnRequest> => {
    const context = await options.load(scope);
    if (context === null) return request;

    // The scope and the context it loaded must agree on which repository this
    // is. They come from different places — the scope from the session
    // manager, the facts from the backend's own store — and a mismatch means
    // one conversation is about to be hydrated with another project's history.
    //
    // That is the cross-project boundary the corpus tests at the prompt level,
    // arriving here as a plumbing bug instead of an attack. Refusing to hydrate
    // is the safe failure: the turn proceeds with less context, which is the
    // same degradation as a failed load, rather than with the wrong context,
    // which nothing downstream could detect.
    //
    // Only checkable at all because main renamed the scope key to
    // `githubRepositoryId`; against the old free-form `repositoryId` there was
    // no common identifier to compare.
    if (context.facts.githubRepositoryId !== scope.githubRepositoryId) {
      options.onScopeMismatch?.(scope);
      return request;
    }

    const memory = rehydrationContext(context.sharedHistory, context.projectFacts);
    const rendered = getFormat(formatId).render(toTurnInput(context, memory));

    // `runtimePrompt` carries the full rendered turn; `persistedSummary` carries
    // the compact durable summary on its own. They are separate fields in the
    // runtime contract, and keeping them separate lets a provider adapter put
    // the summary somewhere cheaper than the prompt if it can.
    return {
      ...request,
      runtimePrompt: rendered.system + "\n\n---\n\n" + rendered.user,
      persistedSummary: (memory.summary ?? "").slice(
        0,
        PROTOCOL_LIMITS.maxProjectSummaryChars,
      ),
    };
  };
}

/* ========================================================================== *
 * Building a turn request from scratch
 * ========================================================================== */

export interface BuildTurnRequestOptions {
  context: DurableConversationContext;
  /** Absolute workspace path, from the backend's runtime binding. */
  workspacePath: string;
  agentId: string;
  correlationId: string;
  format?: ProtocolFormatId;
  /** Defaults to `continue`, letting the session manager resume when it can. */
  sessionMode?: "continue" | "fresh" | "ephemeral";
  maxTurns?: number;
}

/**
 * Assembles a complete `ManagedAgentTurnRequest` for a protocol turn.
 *
 * The sandbox and network settings are not parameters, and that is deliberate.
 * Both agent jobs read a repository and draft text; neither writes, and neither
 * needs the network. Making them arguments would eventually mean someone passes
 * `workspace-write` for a reason that seems good at the time, and a
 * prompt-injection case that persuades the agent to modify the repository would
 * then succeed instead of failing at the OS boundary.
 */
export function buildTurnRequest(
  options: BuildTurnRequestOptions,
): ManagedAgentTurnRequest {
  const memory = rehydrationContext(
    options.context.sharedHistory,
    options.context.projectFacts,
  );
  const rendered = getFormat(options.format ?? "P5").render(
    toTurnInput(options.context, memory),
  );
  const role = options.context.role;

  return {
    agentId: options.agentId,
    purpose: PROTOCOL_PURPOSES[role],
    workspacePath: options.workspacePath,
    runtimePrompt: rendered.system + "\n\n---\n\n" + rendered.user,
    persistedSummary: (memory.summary ?? "").slice(
      0,
      PROTOCOL_LIMITS.maxProjectSummaryChars,
    ),
    sandboxMode: "read-only",
    networkMode: "none",
    outputSchemaName: PROTOCOL_OUTPUT_SCHEMAS[role],
    correlationId: options.correlationId,
    maxTurns: options.maxTurns ?? PROTOCOL_LIMITS.maxClarificationTurns,
    ...(options.sessionMode ? { sessionMode: options.sessionMode } : {}),
  };
}
