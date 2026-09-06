/**
 * How hard a caller may ask a provider to think before it answers.
 *
 * The second runtime choice a product surface makes, after the model. Kept
 * apart from `RUNTIME_MODELS` because it is not a per-provider catalogue: the
 * same three values mean the same thing on both providers, and a picker that
 * offered different rungs per provider would be describing our plumbing rather
 * than the choice.
 *
 * An allowlist for the same reason models are one, and for a sharper one:
 * neither CLI falls back on a value it dislikes, and each fails differently.
 * Measured against codex-cli 0.153.4, a value the CLI itself does not know
 * exits 1 with an empty stderr; a value the CLI knows but the chosen model does
 * not support comes back as a `turn.failed` event from the API instead. Both
 * arrive after a connector has claimed the turn, so an unchecked string costs
 * the owner a failed draft rather than a 400.
 *
 * Each CLI accepts rungs the other does not -- Claude's `--effort` takes
 * `low, medium, high, xhigh, max`, Codex's `model_reasoning_effort` also takes
 * `none` -- and on Codex the accepted set narrows again per model, which is how
 * the second failure mode was found: `minimal` is a value codex-cli forwards
 * and `gpt-5.6-sol` rejects. So the offer is the intersection that was actually
 * run, not the union of two `--help` texts. These three passed a real turn on
 * every model in `RUNTIME_MODELS`, both providers, 24 turns, all exiting 0 with
 * assistant text. `xhigh` and `max` are left out for want of that evidence, not
 * because they are known bad; verify them the same way before adding them.
 */
export const RUNTIME_EFFORTS = ["low", "medium", "high"] as const;

export type RuntimeEffort = (typeof RUNTIME_EFFORTS)[number];

/**
 * What every turn reasons at when nobody chooses.
 *
 * Both providers read this constant rather than spelling `"medium"` out
 * themselves -- Claude through `buildClaudeArgs`, Codex through
 * `closedToolSurface()` -- so the value `GET /api/runtime/models` reports as
 * `defaultEffort` is the value that actually runs. That is the same guarantee
 * `DEFAULT_RUNTIME_MODEL` gives for models, and it exists because the two once
 * disagreed: Codex was pinned at medium while Claude's research pass ran at the
 * CLI's maximum simply because nothing set the flag.
 *
 * Medium and not the CLI default, because the CLI default is the maximum and
 * most of a Telaegent turn is not a thinking problem. Measured on the drafting
 * pass, whose evidence arrives pre-gathered in the research note: 38.6s unset
 * against 23.0s at medium, the whole difference being thinking emitted before
 * the first character of the answer, and the answer itself unchanged.
 */
export const DEFAULT_RUNTIME_EFFORT: RuntimeEffort = "medium";

/** Whether a caller may ask for this effort. */
export function isSupportedEffort(effort: string): effort is RuntimeEffort {
  return (RUNTIME_EFFORTS as readonly string[]).includes(effort);
}

/**
 * The effort a turn will actually reason at, given an optional caller choice.
 *
 * Returns the default rather than `undefined` for an absent choice, so a caller
 * can be told what it will get without duplicating this table.
 */
export function resolveEffort(effort?: string | undefined): RuntimeEffort {
  if (effort === undefined || effort === "") return DEFAULT_RUNTIME_EFFORT;
  if (!isSupportedEffort(effort)) {
    throw new UnsupportedEffortError();
  }
  return effort;
}

/** Safe validation error. Carries no caller value. */
export class UnsupportedEffortError extends Error {
  public readonly code = "UNSUPPORTED_RUNTIME_EFFORT";

  constructor() {
    super("Requested reasoning effort is not available");
    this.name = "UnsupportedEffortError";
  }
}
