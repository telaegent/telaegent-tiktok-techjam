import type { AgentProvider } from "./runtime-contract.js";

/**
 * The models a caller may ask a provider for.
 *
 * This is an allowlist rather than a passthrough because `model` is the one
 * runtime field a product surface chooses. Everything else in a turn request is
 * built by the server (see `AuthorizedPrivateRuntimeTurnStarter`), so an
 * unchecked string here would be the only caller-supplied value reaching an
 * argv. Both CLIs do reject an unknown model on their own -- measured, they
 * exit 1 rather than falling back silently -- but they reject it after the
 * connector has claimed a turn, so the owner pays a failed draft for a typo the
 * server could have refused.
 *
 * Every entry was verified on 2026-09-06 by running `hello` turns through the
 * production flag surface -- the same argv `buildClaudeArgs` and
 * `buildCodexArgs` produce -- against claude 2.1.263 and codex-cli 0.153.4.
 * A model is listed only if those turns exited 0 and returned assistant text;
 * six turns each, all passing.
 *
 * Note for anyone tempted to order this list by speed from that run: don't.
 * A single sample put two models in the wrong order, and at n=5 only a coarse
 * two-tier split survives. The numbers live in docs/team/duy-model-selection-api.md
 * with the caveats attached.
 *
 * The aliases are deliberate for Claude: the CLI accepts both an alias and a
 * full model name, and an alias keeps following the latest model of that family
 * instead of pinning a dated ID we would have to chase. What each one resolved
 * to at verification time is recorded beside it, from the CLI's own init event.
 */
export const RUNTIME_MODELS = {
  claude: [
    "opus", // -> claude-opus-5
    "sonnet", // -> claude-sonnet-5
    "haiku", // -> claude-haiku-4-5-20251001
    "fable", // -> claude-fable-5-1
  ],
  codex: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"],
} as const satisfies Record<AgentProvider, readonly string[]>;

/**
 * What each provider runs when nobody chooses.
 *
 * This is the product's choice, not a description of what the CLIs happen to
 * do. `loadConfig()` reads it into `claudeModel` / `codexModel`, so a turn with
 * no caller choice really is answered by the model named here -- the same value
 * `GET /api/runtime/models` reports as `defaultModel`. Reporting one default and
 * applying another is the bug this arrangement exists to prevent.
 *
 * Precedence, widest to narrowest: this table, then an operator's
 * `CLAUDE_MODEL` / `CODEX_MODEL`, then the caller's `model`. A self-hosted
 * deployment can still pin whatever it likes, and a picker still beats it.
 *
 * On Claude that last step is a real question, because the deployment default
 * arrives as the `ANTHROPIC_MODEL` environment variable rather than a flag;
 * measured against 2.1.263 with `ANTHROPIC_MODEL=sonnet` and `--model haiku`,
 * the flag won. On Codex it does not arise: `closedToolSurface()` passes
 * `--ignore-user-config`, so `--model` is the only model input the CLI sees.
 *
 * `codex` is `gpt-5.6-sol` rather than the `gpt-6-astra` the CLI itself falls
 * back to. Astra was the slowest model measured on either provider (median 7.2s
 * against sol's 5.2s on a one-word turn) and a private turn already spends a
 * research pass and a drafting pass before the owner sees anything.
 */
export const DEFAULT_RUNTIME_MODEL = {
  claude: "opus",
  codex: "gpt-5.6-sol",
} as const satisfies Record<AgentProvider, string>;

export type RuntimeModelId = (typeof RUNTIME_MODELS)[AgentProvider][number];

/** Whether this provider can be asked for this model. */
export function isSupportedModel(
  provider: AgentProvider,
  model: string,
): boolean {
  return (RUNTIME_MODELS[provider] as readonly string[]).includes(model);
}

/**
 * The model a turn will actually run on, given an optional caller choice.
 *
 * Returning the default rather than `undefined` for an absent choice keeps the
 * value reportable: a caller can be told which model answered without having to
 * duplicate this table.
 */
export function resolveModel(
  provider: AgentProvider,
  model?: string | undefined,
): string {
  if (model === undefined || model === "") return DEFAULT_RUNTIME_MODEL[provider];
  if (!isSupportedModel(provider, model)) {
    throw new UnsupportedModelError();
  }
  return model;
}

/** Safe validation error. Carries no caller value. */
export class UnsupportedModelError extends Error {
  public readonly code = "UNSUPPORTED_RUNTIME_MODEL";

  constructor() {
    super("Requested model is not available for this provider");
    this.name = "UnsupportedModelError";
  }
}
