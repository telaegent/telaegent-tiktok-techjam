# Model selection — API for the frontend

**For:** Duy · **From:** Phuong (server/runtime) · **Date:** 2026-09-06
**Status:** implemented on `feat/model-selection`, not yet merged
**Scope:** two additions to the existing API. Nothing already shipped changes.

---

## TL;DR

1. **`GET /api/runtime/models`** — new. Returns the models each provider offers
   and which one it uses by default. Build the picker from this, don't hardcode.
2. **`POST /api/drafts/:draftId/run`** — now accepts an optional
   `{ "model": "..." }` body. Omit it and the run behaves exactly as it does
   today.

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
      "defaultModel": "gpt-6-astra"
    }
  ]
}
```

- `models` is ordered. Render it in that order — strongest/most general first.
- `defaultModel` is what runs when the user picks nothing. Pre-select it, so the
  picker never shows a choice the server wouldn't actually make.
- `401 { "error": "Authentication required" }` when signed out. It leaks nothing,
  but it sits behind auth because it exists only for a logged-in screen.
- Sent as `Cache-Control: private, no-store`, like the rest of the surface.
  Fetching it once per session is fine; it does not change while the server runs.

**Do not hardcode the lists.** They will grow, and every entry was earned by an
actual verification run (section 4) — a hardcoded copy in the web app is a copy
that will eventually offer a model the server rejects.

---

## 2. `model` on the run endpoint

```
POST /api/drafts/:draftId/run
Content-Type: application/json

{ "model": "sonnet" }
```

- **Optional.** No body at all, `{}`, or an omitted `model` all mean "don't
  choose" — which is exactly what this endpoint did before. Your current call
  site keeps working untouched.
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
| Unknown key in the run body | `400` | `{ "error": "...", "details": [ …zod issues… ] }` |
| `model` empty or over 64 chars | `400` | `{ "error": "...", "details": [ … ] }` |
| Not signed in | `401` | `{ "error": "Authentication required" }` |
| Draft is not in `created` (already ran) | `409` | `{ "error": "Private draft cannot be run" }` |

**A rejected model does not burn the draft.** The check runs before the draft is
marked running, so on a `400` the draft is still `created` and the owner can pick
again and re-run the same draft. Don't recreate anything, don't navigate away —
show the error next to the picker and leave the UI where it is.

The two model `400`s are indistinguishable by body on purpose: the message never
echoes the value the caller sent. If you want to tell "wrong provider" from
"typo" in the UI, decide client-side against the catalogue you already fetched —
you have everything needed to know which one it is.

---

## 4. What the models actually are

Every model in the catalogue was verified on 2026-09-06 by running one real
`hello` turn through the exact argv the product builds, against
`claude 2.1.263` and `codex-cli 0.153.4`. A model is listed only if that turn
exited 0 and returned assistant text.

| Provider | Value to send | Resolved to | hello turn |
| --- | --- | --- | --- |
| claude | `opus` *(default)* | `claude-opus-5` | 9.2s |
| claude | `sonnet` | `claude-sonnet-5` | 4.5s |
| claude | `haiku` | `claude-haiku-4-5-20251001` | 7.2s |
| claude | `fable` | `claude-fable-5-1` | 6.7s |
| codex | `gpt-6-astra` *(default)* | `gpt-6-astra` | 5.8s |
| codex | `gpt-5.6-sol` | `gpt-5.6-sol` | 7.5s |
| codex | `gpt-5.6-luna` | `gpt-5.6-luna` | 3.6s |
| codex | `gpt-5.5` | `gpt-5.5` | 5.1s |

The Claude values are **aliases on purpose** — the CLI accepts both an alias and
a dated model ID, and an alias keeps following the latest model of that family so
we never have to chase a version string. "Resolved to" is what the CLI reported
at verification time; it's a label to display, not a value to send.

**Those timings are a one-word prompt, not product latency.** They are not a
ranking and shouldn't be shown to users as "speed" — a real Telaegent turn does
investigation plus drafting and is dominated by the work, not the model. If the
UI wants to hint at a tradeoff, describe capability, not seconds.

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
- The whole turn uses one model. Both internal passes (investigation and
  drafting) and every follow-up round run on whatever was chosen. You can't
  switch mid-turn, and shouldn't want to.

**There is no per-user model preference API.** If the product wants a sticky
default, tell me — it needs a schema change, so it isn't free.

---

## 6. Types to copy

```ts
export type AgentProvider = "claude" | "codex";

export interface RuntimeModelCatalogue {
  providers: Array<{
    provider: AgentProvider;
    /** Ordered. Render in this order. */
    models: string[];
    /** Pre-select this. It is what runs when `model` is omitted. */
    defaultModel: string;
  }>;
}

/** Body for POST /api/drafts/:draftId/run — the one field is optional. */
export interface RunDraftBody {
  /** Must be one of `models` for the *draft's* provider. Omit for the default. */
  model?: string;
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

// when the owner hits Run
try {
  const { pollUrl } = await api.post(
    `/api/drafts/${draft.draftId}/run`,
    { model },                     // or {} to accept the server default
  );
  startPolling(pollUrl);
} catch (error) {
  if (error.status === 400) {
    // The draft is still `created`. Show the message beside the picker and let
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
- **It does not expose reasoning effort.** Both providers are pinned to `medium`
  server-side. That's a deployment decision, not a user one.
- **It does not override a self-hosted deployment.** If an operator sets
  `CLAUDE_MODEL` / `CODEX_MODEL`, a run that names no model still uses their
  setting, and a run that names one always beats it. Nothing for you to handle —
  it just means "no choice" is not the same as "the default", which is why the
  server never sends a model it wasn't given.

---

**Questions to me, not to the code.** The catalogue is the contract. If a model
you want isn't in it, that's because nobody has run a turn on it yet — I'd rather
add it after verifying than have the picker offer something that 400s.
