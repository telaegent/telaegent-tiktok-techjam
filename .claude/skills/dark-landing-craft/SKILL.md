---
name: dark-landing-craft
description: Craft method for premium dark-theme landing pages, marketing sites, and hero sections — the kind that look like Linear, Vercel, Stripe, or x.ai rather than a bootstrap template. Covers composition and section rhythm, typographic scale, spacing systems, depth without heavy shadows, restrained colour, motion budget, and the specific tells that make a page read as generic. Use this skill whenever the user asks for a landing page, marketing page, hero section, product page, splash page, or "make this look better/more premium/more polished", and whenever you are about to write CSS for a dark-theme site — even if they did not say the word "design". Also use it when reviewing or critiquing an existing page's visual quality, and especially when the user points at a reference site and asks you to match, clone, or take inspiration from its look — the skill covers how to measure a reference properly instead of guessing at it.
---

# Dark landing craft

Premium landing pages are not the result of more effects. They are the result of
fewer decisions, applied consistently. A page reads as expensive when every size,
space, and colour on it can be traced back to a small system — and reads as
generic when each section was styled on its own.

Work in this order. Skipping to surface is the single most common failure.

1. **Structure** — what sections, in what order, and what each one has to prove.
2. **Hierarchy** — what the eye hits first, second, third, in every section.
3. **Surface** — type, colour, depth, motion.

## Matching a reference

When the user names a site to look like, fidelity to that site outranks every
general rule in this file, including the composition advice below. They are not
asking for your taste applied to their content; they are asking for that site's
visual language applied to their content.

**Measure it. Do not eyeball it.** Screenshots lie about the things that matter
most — exact greys, radii, font weights, padding — and headless browser panes
often refuse to render a scroll-animated page at all. Read the computed styles
instead:

```js
const cs = (el, props) => { const c = getComputedStyle(el); const o = {};
  props.forEach(p => o[p] = c[p]); return o; };
cs(document.querySelector('h2'),
   ['fontSize','fontWeight','letterSpacing','lineHeight','color','textAlign']);
```

Extract, at minimum:

- page background, card background, and whether cards use a **border at all**
- `borderRadius` and `padding` on cards
- heading `fontSize` / `fontWeight` / `letterSpacing`, at more than one level
- muted text colour, size, and line-height
- button `borderRadius`, `padding`, `fontSize`, `fontWeight`
- section block padding and container `max-width`

Then find the **repeating unit** — the one component the page reuses down its
length — and read its actual markup:

```js
document.querySelector('.the-repeating-card').outerHTML.slice(0, 700);
```

That structure is usually the whole look. Getting the palette right while
missing the unit produces a page that shares the reference's colours and none of
its character.

Two failure modes to watch for in yourself:

- **Borders where the reference has none.** Many premium dark sites separate
  surfaces purely by background contrast. Adding 1px borders is the fastest way
  to make a soft design look like a wireframe.
- **Heavier headings than the reference.** Weight 600–700 on dark blooms and
  reads cheap; a lot of these sites sit at 400–500. Check, do not assume.

Deviate only where the reference has content you do not — a pricing table for
something that is not for sale, testimonials you do not have. Replace those
sections with your own equivalent rather than dropping them, and say plainly
which departures you made and why.

## 1. Structure

Decide the argument before the aesthetics. A landing page is a sequence of
claims, each earning the right to the next. Write the section list as sentences
first; if the sentences do not persuade in plain text, no amount of gradient
will save them.

Section archetypes that carry most pages — mix them, do not repeat one six times:

| Archetype | Job |
| --- | --- |
| Hero | One claim, one sentence of support, one primary action |
| Product frame | Proof the thing exists — a real screen, not an abstraction |
| Proof strip | Numbers, logos, or a one-line stat row. Cheap credibility |
| Alternating feature | Copy beside a bespoke visual. Best for sequential concepts |
| Bento grid | Several related capabilities at a glance. Best for parallel ones |
| Process / flow | Ordered stages. Show the connection, not just the chips |
| Contrast band | A visually distinct section for the one thing you most want remembered |
| FAQ | Objection handling. Native `<details>`, no JS |
| Closing | Restate the claim, repeat the action |

**Vary the format — unless you are matching a reference.** Six identical
alternating rows is the most common way a promising page turns monotonous, so
by default, after two or three of one archetype, switch.

But this rule loses to fidelity. Plenty of excellent sites repeat a single
strong unit six or seven times, and if the user has named a reference, the
repetition may be exactly what they are pointing at. Read the reference before
applying this rule — see [Matching a reference](#matching-a-reference). Breaking
a pattern the user asked you to copy reads as failure to copy it, not as
sophistication.

**The contrast band matters more than it looks.** One section that breaks the
page's own pattern — different background tint, different border colour,
different layout — is where the eye rests and the memory sticks. Spend it on
your strongest single idea.

## 2. Hierarchy

In every section, exactly one element should be unambiguously first. If you
cannot say which, the section is flat and will be skimmed past.

Rank with size *and* colour *and* space — not one alone. A heading that is
merely bigger reads as a bigger paragraph; a heading that is bigger, brighter,
and preceded by more space reads as a heading.

The **eyebrow → headline → lede** stack does a lot of work cheaply: a small
uppercase label in the dimmest text colour, the headline at full brightness,
then a lede at 55–65 characters in the mid colour. Three tiers, instantly
parsed, and it gives every section the same entry rhythm without making them
look the same.

## 3. Surface

### Typography

Use one family. A second family is a decision you have to justify; on most
product pages it just adds noise. Weight, size, and colour give you more
differentiation than a typeface pairing will.

Scale — fluid, so it works from 360px to 1600px without breakpoint fiddling:

```css
--step-hero:  clamp(2.6rem, 6.5vw, 5rem);    /* one per page */
--step-h2:    clamp(1.9rem, 3.6vw, 2.9rem);  /* section titles */
--step-h3:    clamp(1.4rem, 2.4vw, 2rem);    /* feature titles */
--step-body:  1.0625rem;                      /* 17px — 16 is a touch small on dark */
--step-small: 0.875rem;
--step-micro: 0.7rem;                         /* eyebrows, tags */
```

Optical rules that separate careful from careless:

- **Negative letter-spacing on large text.** `-0.03em` at hero size, `-0.02em`
  at section size, `0` at body. Type designed for body copy looks loose when
  scaled up. This one adjustment does more for perceived quality than any effect.
- **Positive letter-spacing on small uppercase.** `0.14em` on eyebrows. Caps
  need air.
- **Line-height inverse to size.** `1.02` at hero, `1.1` at h2, `1.6` at body.
- **Measure caps out.** 55–65 characters for body, ~30 for headlines. Set
  `max-width` in `ch`, not `px`.
- **Weight, not boldness.** 550–600 on headings reads more expensive than 700.
  Heavy weights on dark backgrounds bloom and look cheap.

### Colour on dark

Dark themes fail in a specific way: everything becomes the same grey. Build a
deliberate ramp and use all of it.

```css
--bg:          #08090a;  /* near-black, never pure #000 — it kills depth */
--bg-soft:     #0b0c0e;  /* recessed */
--panel:       #101214;  /* raised */
--border:      rgba(255,255,255,0.08);
--border-lift: rgba(255,255,255,0.14);
--text:        #f2f4f6;  /* primary — not pure white, which glares */
--text-dim:    #8f979e;  /* secondary, ~60% */
--text-faint:  #5f676d;  /* eyebrows, metadata, ~40% */
```

Three text tiers used consistently will carry a whole page. Most flat-looking
dark pages are using one and a half.

**One accent.** Pick a single hue (or a two-stop gradient) and let it mean
"this is the brand". Every additional decorative colour halves the impact of
the first.

**Reserve other colours for meaning.** Amber, red, and green should appear only
when they carry semantics — pending, error, success, denied. When colour always
means something, the reader learns the language in one section and reads the
rest fluently. When colour is decorative, they learn nothing and the page gets
noisier the longer it is.

### Depth without heavy shadows

Drop shadows barely register on near-black. Build elevation from:

- **Border contrast** — a raised surface has a slightly brighter border.
- **Background lift** — `--panel` sits on `--bg`; recessed areas go `--bg-soft`.
- **A single deep, soft shadow** on the one hero element only:
  `0 40px 120px -40px rgba(0,0,0,0.9)`. Diffuse and far, not tight and dark.
- **Inner hairline** — `inset 0 1px 0 rgba(255,255,255,0.04)` reads as a lit
  top edge and costs nothing.
- **Grain.** A very low-opacity noise overlay (2–4%) kills banding in gradients
  and is most of why premium dark sites feel like a material rather than a
  screen. See `references/techniques.md`.

**Gradient discipline.** Large soft radial glows behind the hero, at 0.10–0.20
alpha, blurred. Never a hard linear gradient across a whole section — that is
the single loudest tell of a template. Gradients belong behind content, not on it.

### Spacing

One scale, used everywhere. Ad-hoc values are what make a page feel slightly
off in a way people cannot name.

```css
/* 4px base: 4 8 12 16 24 32 48 64 96 128 */
```

- Section padding: `clamp(4rem, 7.5vw, 6.5rem)` block. Generous, but if the
  gaps read as empty rather than calm, you have over-padded — tighten before
  adding filler.
- Space belongs *above* a heading, not below it. Grouping comes from proximity;
  a heading close to its own paragraph and far from the previous block is how a
  reader knows what belongs to what.
- Equalise card heights in grids (`height: 100%` on the card, and on any
  wrapper element that is the actual grid item). Ragged card bottoms are a
  small thing that reads as unfinished.

### Motion

Motion should confirm structure, never perform. Budget:

- **Reveal on scroll** — 16–20px rise, 600–700ms, ease-out. Once, then done.
- **Stagger siblings** 60–90ms. More than ~150ms feels sluggish.
- **Hover** — 1px lift or a border brightening, 150–200ms.
- Nothing loops. Nothing bounces. Nothing moves more than ~24px.

Two hard requirements, because they are correctness rather than taste:

- Honour `prefers-reduced-motion: reduce` — disable transitions and show all
  revealed content.
- **Never let content depend on an effect to become visible.** If the reveal
  mechanism fails, the page must still read. Prefer a shared, rAF-throttled
  scroll pass over per-element `IntersectionObserver`: it is cheaper and its
  failure mode is inspectable. Elements already in view at mount show
  immediately rather than waiting for a scroll that may never come.

## Responsive

Design the narrow layout as its own thing, not as a squeezed desktop.

- Collapse two-column features to one, and make sure the visual does not end up
  above its own heading — reset any `order` flip at the breakpoint.
- Sidebars become horizontal strips or scrollable rows.
- Full-width buttons below ~720px.
- Verify `document.documentElement.scrollWidth === window.innerWidth` at 390px.
  Horizontal overflow on mobile is the most common shipped bug on landing pages.

## Anti-patterns

These are the specific tells of a generated-looking page:

- Emoji as iconography. Use inline SVG at 14–16px, `stroke="currentColor"`.
- A hard linear gradient as a section background.
- Five accent colours, none of which mean anything.
- Pure `#000` background with pure `#fff` text.
- Every section the same two-column layout.
- Card grids where the cards are different heights.
- Uniform spacing everywhere, so nothing groups.
- Glassmorphism on everything instead of on one navbar.
- Headline set at weight 700–800 with default letter-spacing.
- Lorem-flavoured copy: "Powerful features", "Seamless integration",
  "Built for scale". Specific beats superlative every time — a real file path,
  a real number, a real state name is worth a paragraph of adjectives.

## Before calling it done

Look at the page at 50% zoom, where you cannot read the words. You should still
see clear rhythm, obvious focal points, and varied section shapes. If it reads
as a uniform grey column, the problem is structure, not surface — go back to
step 1 rather than adding effects.

Then check:

- If there was a reference: card background, radius, border presence, heading
  weight, and the repeating unit all match the measured values — not your
  recollection of them.
- One element is clearly first in every section.
- Text uses all three brightness tiers.
- Accent colour means one thing; semantic colours mean their thing.
- Spacing values all come from the scale.
- No horizontal scroll at 390px.
- Reduced-motion path shows everything.
- Every string is specific to this product.

## References

- `references/techniques.md` — copy-paste CSS for grain, aurora glows, gradient
  text, sticky-blur nav, bento grids, and the reveal implementation.
