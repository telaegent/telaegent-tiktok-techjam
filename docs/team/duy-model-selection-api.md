# Model and effort selection — API for the frontend

**For:** Duy · **From:** Phuong (server/runtime) · **Date:** 2026-09-06
**Status:** implemented and merged on `main`
**Scope:** two additions to the existing API. Nothing already shipped changes.

---

## TL;DR

1. **`GET /api/runtime/models`** — new. Returns the models each provider offers,
   the reasoning efforts (the same list whatever the provider), and the default
   for each. Build both pickers from this, don't hardcode.
2. **`POST /api/drafts/:draftId/run`** — now accepts an optional
   `{ "model": "...", "effort": "..." }` body. The two are independent; omit
   both and the run behaves exactly as it does today.

There is nothing else. No new draft field, no new state, no migration.

---

## 1. `GET /api/runtime/models`

Authenticated (same session as everything else). No parameters.

```jsonc
// 200
{
  "providers": [
    {
      "provider": "claude",
      "models": ["opus", "sonnet", "haiku", "fable"],
      "defaultModel": "opus"
    },
    {
      "provider": "codex",
      "models": ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"],
      "defaultModel": "gpt-5.6-sol"
    }
  ],
  "efforts": ["low", "medium", "high"],
  "defaultEffort": "medium"
}
```

- `models` is ordered. Render it in that order — strongest/most general first.
- `defaultModel` is what runs when the user picks nothing. **Pre-select it, and
  don't assume it is the first entry** — on Codex it isn't. `gpt-6-astra` leads
  the list as the newest model, while the default is `gpt-5.6-sol`, which
  measured meaningfully quicker on a turn the owner is sitting there waiting for.
- `defaultModel` is the model that actually runs, not a label. The server reads
  the same constant to configure the run, so the two can't drift.
- `401 { "error": "Authentication required" }` when signed out. It leaks nothing,
  but it sits behind auth because it exists only for a logged-in screen.
- `efforts` is ordered least to most thinking, and it is **top-level, not per
  provider**, because the rungs mean the same thing on both. Don't look it up by
  provider and don't filter it — there is one ladder and every draft can use all
  of it.
- `defaultEffort` carries the same guarantee as `defaultModel`: the runners read
  the same constant, so the value reported here is the value that runs.
- Sent as `Cache-Control: private, no-store`, like the rest of the surface.
  Fetching it once per session is fine; it does not change while the server runs.

**Do not hardcode the lists.** They will grow, and every entry was earned by an
actual verification run (section 4) — a hardcoded copy in the web app is a copy
that will eventually offer a model the server rejects.

---

## 2. `model` and `effort` on the run endpoint

```
POST /api/drafts/:draftId/run
Content-Type: application/json

{ "model": "sonnet", "effort": "high" }
```

- **Both optional, and independent.** No body at all, `{}`, an omitted `model`,
  an omitted `effort` — all mean "don't choose", which is exactly what this
  endpoint did before. Sending only one is normal. Your current call site keeps
  working untouched.
- `effort` must be one of the top-level `efforts` list. Unlike `model` it does
  not depend on the draft's provider, so the same three values are valid on
  every draft.
- Success is unchanged: `202` with `{ draft, pollUrl }`, and you keep polling
  `GET /api/drafts/:draftId` the same way.
- The body is strict. An unknown key is a `400`, so don't send `provider` here —
  the provider is already on the draft.

### The provider is not yours to send

A draft is created with a provider (`POST /api/conversations/:id/drafts` takes
`provider: "claude" | "codex"`). The run endpoint reads the provider off the
draft. So:

> **Filter the picker by the draft's own `provider`, which is already on the
> `PrivateDraftView` you render.**

```ts
const catalogue = byProvider.get(draft.provider); // draft.provider, not a user choice
```

Sending `opus` (a real model) on a Codex draft is a `400`. That is deliberate —
it is a caller bug, not something to silently fall back from.

---

## 3. Errors

| Case | Status | Body |
| --- | --- | --- |
| Model not offered by this draft's provider | `400` | `{ "error": "Requested model is not available for this provider" }` |
| Model in no catalogue at all (a typo) | `400` | same as above |
| `effort` not on the ladder | `400` | `{ "error": "...", "details": [ …zod issues… ] }` |
| Unknown key in the run body | `400` | `{ "error": "...", "details": [ …zod issues… ] }` |
| `model` empty or over 64 chars | `400` | `{ "error": "...", "details": [ … ] }` |
| Not signed in | `401` | `{ "error": "Authentication required" }` |
| Draft is not in `created` (already ran) | `409` | `{ "error": "Private draft cannot be run" }` |

Note the two shapes. A bad `model` gets a plain `{ error }`, because the check
needs the draft's provider and therefore happens past the schema. A bad `effort`
gets the schema's `{ error, details }`, because the ladder is the same on every
provider and the route rejects it outright — the `details` name the accepted
values. Neither is worth special-casing: you have the catalogue, so render
whichever `error` came back.

**A rejected model or effort does not burn the draft.** The checks run before the
draft is marked running, so on a `400` the draft is still `created` and the owner
can pick again and re-run the same draft. Don't recreate anything, don't navigate
away — show the error next to the picker and leave the UI where it is.

The two model `400`s are indistinguishable by body on purpose: the message never
echoes the value the caller sent. If you want to tell "wrong provider" from
"typo" in the UI, decide client-side against the catalogue you already fetched —
you have everything needed to know which one it is.

---

## 4. What the models and efforts actually are

Every model in the catalogue was verified on 2026-09-06 by running real `hello`
turns through the exact argv the product builds, against `claude 2.1.263` and
`codex-cli 0.153.4`. A model is listed only if those turns exited 0 and returned
assistant text — 6 turns each (1 syntax check, then 5 more for the timings
below), 48 in total, all passing.

| Provider | Value to send | Resolved to |
| --- | --- | --- |
| claude | `opus` *(default)* | `claude-opus-5` |
| claude | `sonnet` | `claude-sonnet-5` |
| claude | `haiku` | `claude-haiku-4-5-20251001` |
| claude | `fable` | `claude-fable-5-1` |
| codex | `gpt-6-astra` | `gpt-6-astra` |
| codex | `gpt-5.6-sol` *(default)* | `gpt-5.6-sol` |
| codex | `gpt-5.6-luna` | `gpt-5.6-luna` |
| codex | `gpt-5.5` | `gpt-5.5` |

The Claude values are **aliases on purpose** — the CLI accepts both an alias and
a dated model ID, and an alias keeps following the latest model of that family so
we never have to chase a version string. "Resolved to" is what the CLI reported
at verification time; it's a label to display, not a value to send.

### Speed: two tiers, and that is all the data supports

Measured properly — 5 sequential `hello` runs per model, medians below. An
earlier single-sample version of this table had two models in the wrong order,
so treat anything finer than these tiers as noise.

| Provider | Quicker | Slower |
| --- | --- | --- |
| claude | `haiku` 4.2s · `sonnet` 4.5s | `fable` 7.0s · `opus` 9.1s |
| codex | `gpt-5.6-luna` 4.6s · `gpt-5.5` 4.7s · `gpt-5.6-sol` 5.2s | `gpt-6-astra` 7.2s |

**Only the gap between the two columns is real.** Within a column the runs
overlap almost entirely — `haiku` and `sonnet` sit inside each other's range,
and so do `luna`, `gpt-5.5` and `sol`. Do not order the picker by these numbers
or render them as a per-model figure.

**And this is still a one-word prompt, not product latency.** A real Telaegent
turn is a research pass plus a drafting pass. On this repository the research
pass alone runs 25–30s — five to seven tool calls and a ~1.2k-character note —
so the turn a user actually waits on is dominated by work these numbers don't
cover. If the UI wants to hint at a tradeoff, "quicker / more thorough" is
honest; a number in seconds is not.

The default is `sol` on Codex rather than `astra` for exactly this reason: two
passes at astra's pace is the one place where a 2-second-per-call gap is
actually felt.

On Claude the default stays `opus`, and that is a measurement rather than a
preference. Running the product's real research pass against this repository at
`opus` and at `sonnet` — same argv, same prompt, effort pinned at medium, three
runs each — gave medians of **28.3s and 27.6s**, with sonnet the more variable of
the two (21.1–34.0s against 24.8–30.0s). The 9.1s-against-4.5s gap in the table
above does not survive contact with a pass that spends its time on tool calls and
on emitting a note. Opus is not costing us anything measurable on a real turn, so
the default keeps the stronger model. Whoever wants the one-word-turn speed can
pick it; that is what the picker is for.

### The effort ladder

`low`, `medium`, `high`. Verified the same way and on the same day: every rung
run against every model in the catalogue, both providers, through the argv the
product builds — 24 turns, all exiting 0 with assistant text.

Two rungs that exist and are **not** offered, so you know they were considered:

- `none` (Codex only) has no Claude equivalent.
- `xhigh` and `max` are real on both CLIs but no product turn has been run on
  them, and this list only carries what has.

The allowlist is not politeness. Neither CLI falls back from an effort it
dislikes — codex-cli exits 1 on a value it doesn't know, and the API fails the
turn on a value the *model* doesn't take, which is model-specific: `minimal` is
a value codex-cli forwards happily and `gpt-5.6-sol` refuses. A rung that isn't
on this list costs the owner a dead turn, not a fallback.

**Do not sell effort as a speed control.** It is a depth control, and the one
place it visibly buys time it also costs answer length. Measured on the drafting
pass with a populated research note: 38.6s at the CLI's maximum, 23.0s at
`medium`, 14.2s at `low` — but `low` returned 2425 characters where `medium`
returned 4131. On the research pass the difference all but disappears (medians
25.4s at `medium` against 26.7s unset, n=3), because that pass spends its time
on tool calls rather than on thinking. So:

> "quicker, shorter" / "balanced" / "more thorough" is honest labelling.
> "3× faster" is not.

---

## 5. Rules that shape the UI

**The choice belongs to the run, not to the draft.** It is deliberately not
persisted. What that means for you:

- Every run is a fresh choice. Hold the picker value in component state and send
  it with each run; the server will never hand it back.
- **A draft resumed after a reload has no stored model** — it runs on the
  deployment default again unless you send one. If the choice should survive a
  reload, that's `localStorage` on your side, not the server's.
- **Clarification loops re-run.** When the agent asks a question the draft
  returns to `created` and the owner runs it again, so the picker is live again
  at that moment. Keeping the last choice pre-selected is the right behaviour.
- The whole turn uses one model and one effort. Both internal passes
  (investigation and drafting) and every follow-up round run on whatever was
  chosen. You can't switch mid-turn, and shouldn't want to.
- **Effort is per run, exactly like model** — same non-persistence, same
  re-pick on a clarification loop, same `localStorage` answer if it should
  survive a reload.

**There is no per-user preference API for either.** If the product wants a
sticky default, tell me — it needs a schema change, so it isn't free.

---

## 6. Types to copy

```ts
export type AgentProvider = "claude" | "codex";

export type RuntimeEffort = "low" | "medium" | "high";

export interface RuntimeModelCatalogue {
  providers: Array<{
    provider: AgentProvider;
    /** Ordered. Render in this order. */
    models: string[];
    /** Pre-select this. It is what runs when `model` is omitted. */
    defaultModel: string;
  }>;
  /** Ordered least to most thinking. Not per provider — one ladder for both. */
  efforts: RuntimeEffort[];
  /** Pre-select this. It is what runs when `effort` is omitted. */
  defaultEffort: RuntimeEffort;
}

/** Body for POST /api/drafts/:draftId/run — both fields optional, independent. */
export interface RunDraftBody {
  /** Must be one of `models` for the *draft's* provider. Omit for the default. */
  model?: string;
  /** Must be one of `efforts`. Provider-independent. Omit for the default. */
  effort?: RuntimeEffort;
}
```

---

## 7. Worked example

```ts
// once per session
const catalogue: RuntimeModelCatalogue = await api.get("/api/runtime/models");
const byProvider = new Map(catalogue.providers.map((p) => [p.provider, p]));

// when the private draft opens
const options = byProvider.get(draft.provider);   // provider comes from the draft
const [model, setModel] = useState(options.defaultModel);
const [effort, setEffort] = useState(catalogue.defaultEffort);   // not per provider

// when the owner hits Run
try {
  const { pollUrl } = await api.post(
    `/api/drafts/${draft.draftId}/run`,
    { model, effort },             // or {} to accept the server defaults
  );
  startPolling(pollUrl);
} catch (error) {
  if (error.status === 400) {
    // The draft is still `created`. Show the message beside the pickers and let
    // them choose again — do not recreate the draft, do not navigate away.
    showPickerError(error.body.error);
  }
}
```

---

## 8. Things this API deliberately does not do

- **It does not report which model answered.** If a finished draft should say
  "answered by Sonnet", ask me — it's a small addition to the draft view, but
  nothing stores it today.
- **It does not report which effort a finished draft ran at,** for the same
  reason it does not report the model: nothing stores it.
- **It does not offer every rung either CLI accepts.** See section 4 — the list
  is what has been run, not what would parse.
- **It does not override a self-hosted deployment.** If an operator sets
  `CLAUDE_MODEL` / `CODEX_MODEL`, a run that names no model uses their setting
  instead of the default above, and a run that names one always beats both.
  Nothing for you to handle; it only means `defaultModel` is what *our*
  deployment runs, not a law about every deployment.

---

**Questions to me, not to the code.** The catalogue is the contract. If a model
you want isn't in it, that's because nobody has run a turn on it yet — I'd rather
add it after verifying than have the picker offer something that 400s.
