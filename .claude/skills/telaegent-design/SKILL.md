---
name: telaegent-design
description: The Telaegent visual identity and UI design system — brand colours sampled from the logo, the dark token ramp, the trust-state colour language, component primitives (cards, tags, paths, approvals, agent rail), copy voice, and the locked frontend stack. Use this skill whenever building or changing any Telaegent user interface: the landing page, the product shell, conversation cards, approval or permission UI, ContextPack views, the audit drawer, or anything under apps/web or a Telaegent frontend folder. Also use it when picking colours, writing UI copy, or reviewing Telaegent screens for consistency — the colour-semantics rule in particular is easy to violate by accident and hard to notice afterwards.
---

# Telaegent design system

Telaegent is trust middleware. The interface has one job beyond looking good:
**make the trust boundary legible at a glance.** A viewer should be able to tell,
without reading, whether something was shared automatically, is waiting on a
human, or was refused.

That goal drives the one rule in this system that is not negotiable, below.

Pair this with the `dark-landing-craft` skill for composition, type, and spacing
method. This file covers what is specific to Telaegent.

## Brand

The logo mark is a cyan glyph with a violet node. Those two hues are the brand;
everything else on the page is greyscale plus semantics.

- **Cyan** `#14c4f5` — primary accent
- **Violet** `#6d4aef` — secondary accent
- Together as `linear-gradient(100deg, cyan, violet)` for the one gradient
  moment per page

Logo files live in `ui/logo/`:

| File | Use |
| --- | --- |
| `telaegent-logo-transparent-bright.png` | Wordmark on dark — nav, footer |
| `telaegent-logo-square-transparent-light-text.png` | Square mark — favicon, avatars |

Use the wordmark as the whole nav lockup. Do not put the square mark beside the
word "Telaegent" — the mark already contains the wordmark, so the pair reads as a
duplicate.

**Name spelling.** The logo art spells it **Telaegent**; the written specs
(`docs/plan.md`, `docs/TELAGENT_PRODUCT_FLOW.md`, `CLAUDE.md`) spell it **Telagent**. UI
follows the logo. Keep the name in one exported constant so it can be flipped in
one edit rather than hunted through JSX.

## The colour-semantics rule

**Cyan and violet mean "Telaegent". Amber, red, and nothing else mean a trust
state. No colour is decorative.**

| Colour | Token | Means, and only means |
| --- | --- | --- |
| Cyan | `--cyan` | Brand, or **approved / allowed / automatic** |
| Violet | `--violet` | Brand accent, second owner (Bob) |
| Amber | `--amber` `#f5a524` | **Waiting on a human.** Pending approval, needs input |
| Red | `--red` `#f4525f` | **Refused.** Denied path, blocking conflict, error |

This is why it matters: the product's entire claim is that disclosure is
governed. If amber appears as a highlight somewhere decorative, a viewer who has
learned "amber = a human must decide" now misreads the screen, and the
demonstration quietly stops working. Consistency here is a product feature, not
a style preference.

When you need visual variety, reach for the greyscale ramp, border weight, or
layout — never for a new hue.

## Tokens

```css
:root {
  --bg: #08090a;
  --bg-soft: #0b0c0e;
  --panel: #101214;

  --border: rgba(255,255,255,0.08);
  --border-strong: rgba(255,255,255,0.14);

  --text: #f2f4f6;
  --text-dim: #8f979e;
  --text-faint: #5f676d;

  --cyan: #14c4f5;
  --violet: #6d4aef;
  --amber: #f5a524;
  --red: #f4525f;
  --brand-gradient: linear-gradient(100deg, var(--cyan), var(--violet));

  --font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  --shell: min(1160px, 100% - 3rem);
  --radius: 14px;
  --radius-lg: 20px;
  --ease: cubic-bezier(.22, 1, .36, 1);
}
```

**Monospace carries meaning too.** File paths, branch names, commit hashes,
interface names, TTLs, and denial codes are always mono. It signals "this is a
literal value from the system, not prose", which is exactly the distinction the
product is making.

## Component primitives

The landing page and the product shell must share these, or the marketing page
promises a product that looks different when you open it.

### Tag — the state label

```html
<span class="tag" data-tone="allow|review|deny|neutral">Approved</span>
```

Small uppercase pill, coloured border and 8%-alpha fill of its tone. Every card
that has a trust state opens with one.

### Card — the conversation unit

```html
<article class="card" data-tone="deny">
  <div class="card-head">
    <span class="tag" data-tone="deny">Denied</span>
    <span class="card-title">Request refused before any read</span>
  </div>
  <div class="path-list">…</div>
</article>
```

`data-tone` tints the card's own border and background at ~4% alpha. Untoned
cards stay neutral — most cards should be neutral, so the toned ones stand out.

### Path row — a file with a verdict

```html
<div class="path" data-state="allow"><Check /><code>src/auth/session.ts</code></div>
<div class="path" data-state="deny"><Cross /><code>.env</code><b>FORBIDDEN_PATH</b></div>
```

Mono, icon-led, with the denial code in red at the end. Denied paths get
`text-decoration: line-through` on the code. **Never render the contents of a
denied path** — the point is that it was refused before being read, so showing
its contents would contradict the demonstration.

### Approval pair — the dual-consent unit

```html
<div class="approvals">
  <div class="approval" data-state="approved"><Check /> Bob approved</div>
  <div class="approval" data-state="pending"><Clock /> Alice pending</div>
</div>
```

Always show both owners side by side, never one. The visible asymmetry — one
cyan, one amber — is the fastest way to communicate that two separate humans
must act.

### Agent rail — who is working

Owner, branch, status, and a thin gradient progress bar per agent. Alice is
cyan, Bob is violet, consistently, everywhere. Swapping them between screens
costs the viewer a re-read.

### Citation

```html
<div class="cite">Sessions are stored in Redis with a 24h TTL. <code>session.ts:14-28</code></div>
```

A claim followed by its source in cyan mono. Every ContextPack claim has one —
that is the product's promise.

## Voice

Plain, specific, and honest. The product's credibility depends on not
overselling, so the copy should sound like an engineer explaining a real system.

- Concrete over superlative. "Refused before it is opened" beats "enterprise-grade
  security". Real values — `.env`, `FORBIDDEN_PATH`, `Session`, `af31d4e`,
  `feature/redis-sessions`, score `5` — beat adjectives.
- State limits out loud. "A2A-inspired, not A2A-compliant." "No production
  authentication." A trust product that oversells itself is not a trust product,
  and judges reward the honesty.
- Never claim a fixture is a live run.
- Never imply the model decides. The phrasing that holds throughout: **the model
  proposes, deterministic code authorizes, humans approve.**

Canonical facts to reuse so screens agree with each other: two owners Alice and
Bob, one Phoenix project, the shared `Session` interface, branches
`feature/oauth-provider` and `feature/redis-sessions`, base commit `af31d4e`,
blocking conflict score `5` (shared interface +4, shared module +1), an
eight-file context cap, and the `.env` denial.

## Stack constraints

Locked in `CLAUDE.md`. These are not preferences — adding one breaks the freeze:

- TypeScript, React 19, Vite
- **No** Tailwind, component library, React Router, or state library
- Plain CSS with the tokens above, one stylesheet
- Inline SVG icons, `stroke="currentColor"`, 14–16px. Never emoji.

Navigation without a router: hash state — `#/` landing, `#/demo` product shell,
Playground reachable from a top-level switch.

## Ownership

`apps/web/**` belongs to Thai. Do not edit it as part of another workstream
without saying so. The Starter Kit Playground must keep working — Telaegent is
added beside it, never on top of it.

## Where the reference implementation lives

`C:\Tele frontend` is the built landing page. Its `src/styles.css` is the
working source of these tokens and primitives, and `src/data/content.ts` holds
every string on the page. When extending the design system, change it there
first, then port.
