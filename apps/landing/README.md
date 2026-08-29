# Telaegent — landing page

The public-facing landing view for Telaegent: coordination and trust middleware
for separately owned coding agents.

The `@telaegent/landing` workspace. No backend calls and no runtime
dependencies beyond React, so it runs offline.

## Run it

```bash
npm install
npm run dev -w @telaegent/landing
```

Then open <http://localhost:5174>.

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on port 5174 with HMR |
| `npm run build` | Typechecks, then builds to `dist/` |
| `npm run preview` | Serves the production build |
| `npm run typecheck` | `tsc --noEmit` |

## Stack

React 19, Vite 7, TypeScript, plain CSS. Deliberately matches the locked stack
in the main repo's `CLAUDE.md` — no router, no state library, no Tailwind, no
component library.

## Where to edit

**All copy lives in [`src/data/content.ts`](src/data/content.ts).** Headline,
subhead, the three sharing tiers, the six feature rows, the nine flow stages,
the is/is-not lists, the honest limits, and the FAQ are data. Layout components
only render them, so wording changes never touch JSX.

Two constants at the top of that file are worth knowing about:

- `BRAND` — the product name. The logo artwork spells it **Telaegent**; the
  written specs (`plan.md`, `TELAGENT_PRODUCT_FLOW.md`) spell it **Telagent**.
  This page follows the logo. Change the constant to flip the whole page.
- `DEMO_URL` — where every "Launch Phoenix demo" button points. It defaults to
  the closing CTA anchor because this page is standalone. Point it at the
  running product shell to wire the two together:
  `export const DEMO_URL = "http://localhost:3000/#/demo";`

## Structure

```text
src/
  App.tsx                    section order
  styles.css                 design tokens + all styling
  data/content.ts            every string on the page
  components/
    Nav.tsx                  sticky header, blurs once scrolled
    Hero.tsx                 pill, headline, CTAs
    ProductPreview.tsx       the app frame under the hero
    ProofStrip.tsx           four real numbers from the flow
    Statements.tsx           the six repeating statement cards
    Visual.tsx               the six product visuals
    SharingTiers.tsx         automatic / approval / never
    FlowStrip.tsx            the nine canonical stages
    Security.tsx             the .env refusal (statement card, red)
    Honesty.tsx              is / is-not + stated limits
    Faq.tsx                  native <details> accordion
    Closing.tsx              closing quote, CTAs, footer
    Reveal.tsx               scroll-in animation
    Icons.tsx                inline SVGs
```

## Design notes

The visual language is matched to `x.ai/bot`, measured from the live site
rather than eyeballed:

| Token | Value |
| --- | --- |
| Background | `#0a0a0a` |
| Card | `#1a1a1a`, 24px radius, **no border** — contrast does the work |
| Inner chip | `rgba(255,255,255,.06)`, 16px radius |
| Muted text | `#7d8187`, 18px, line-height 1.625 |
| Headings | weight 400–500, `-0.02em` — never heavy |
| Buttons | full pill, 14px / 500 |
| Section rhythm | ~64px block padding; cards separate, not gaps |

The repeating unit is their **statement card**: one large soft card per idea,
copy held in the left ~54%, the visual occupying the right 42%, dropping
underneath the copy below 880px. Six of them run in sequence, which is their
pattern — the reference site repeats it seven times.

Two deliberate departures:

- **The pricing section is replaced by an honesty section.** A trust product
  should not have a pricing table in a hackathon prototype, and stating the
  limits plainly (A2A-inspired not compliant, no production auth, narrow scope)
  is a stronger differentiator than a feature grid.
- **Colour carries meaning, never decoration.** Cyan→violet is the brand,
  sampled from the logo. Amber means "a human must decide", red means
  "refused". Nothing else is coloured. See the `telaegent-design` skill.

Product substance is real: the conflict score of 5, the `Session` interface
collision, `feature/redis-sessions` vs `feature/oauth-provider`, base commit
`af31d4e`, the eight-file cap, and the `.env` denial all match
`TELAGENT_PRODUCT_FLOW.md`.

## Skills

Two skills in `.claude/skills/` at the repo root capture this work so future
sessions stay consistent:

- `dark-landing-craft` — composition, type scale, dark-mode depth, motion
  budget, and the anti-patterns that make a page look generated.
- `telaegent-design` — the brand, tokens, component primitives, copy voice,
  and the colour-semantics rule.

## Accessibility and robustness

- Respects `prefers-reduced-motion` — reveals and transitions are disabled.
- Keyboard focus rings on every interactive element.
- No horizontal overflow down to 390px; the agent rail becomes a two-column
  strip and the CTAs go full width.
- The Google Fonts link has a full system-font fallback stack, so the page
  still looks right with no network.
