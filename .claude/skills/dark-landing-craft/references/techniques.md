# Techniques

Copy-paste implementations for the effects named in SKILL.md. All are
dependency-free and work with plain CSS.

## Contents

- [Grain overlay](#grain-overlay)
- [Aurora glow](#aurora-glow)
- [Gradient text](#gradient-text)
- [Sticky blur nav](#sticky-blur-nav)
- [Raised panel](#raised-panel)
- [Bento grid](#bento-grid)
- [Reveal on scroll](#reveal-on-scroll)
- [Fluid token block](#fluid-token-block)

## Grain overlay

The cheapest way to make a dark page feel like a material instead of a screen.
It also hides the banding that large radial gradients produce on 8-bit displays.

Inline SVG turbulence as a data URI — no image request, no build step:

```css
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  opacity: 0.035;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
```

Keep opacity between 0.02 and 0.05. Above that it looks dirty. `position: fixed`
means it does not scroll with content, which is what makes it read as film grain
rather than texture printed on the page.

## Aurora glow

Soft brand light behind the hero. Blurred, low alpha, always *behind* content.

```css
.hero { position: relative; overflow: hidden; }

.hero::before {
  content: "";
  position: absolute;
  inset: -40% 0 auto;
  height: 720px;
  background:
    radial-gradient(52% 42% at 34% 42%, rgba(20,196,245,0.16), transparent 68%),
    radial-gradient(46% 40% at 68% 34%, rgba(109,74,239,0.18), transparent 70%);
  filter: blur(28px);
  pointer-events: none;
}

.hero > * { position: relative; }  /* content above the glow */
```

Two offset stops in different hues read as light; one centred stop reads as a
spotlight, which is worse. Keep total alpha under ~0.20 or it becomes a
background colour rather than a glow.

## Gradient text

For one phrase per page — usually the second line of the hero headline.

```css
.gradient-text {
  background: linear-gradient(100deg, var(--cyan), var(--violet));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
```

Angle matters: `100deg` (near-horizontal, slightly tilted) reads deliberate;
`45deg` reads like a template. Never apply to body copy — gradient text at small
sizes loses contrast and fails accessibility.

## Sticky blur nav

```css
.nav {
  position: sticky;
  top: 0;
  z-index: 50;
  border-bottom: 1px solid transparent;
  transition: background-color .25s, border-color .25s, backdrop-filter .25s;
}

.nav[data-stuck="true"] {
  background: rgba(8, 9, 10, 0.78);
  backdrop-filter: blur(14px) saturate(140%);
  border-bottom-color: var(--border);
}
```

```js
const onScroll = () => setStuck(window.scrollY > 8);
window.addEventListener("scroll", onScroll, { passive: true });
```

Transparent until scrolled is the detail people notice without noticing —
it lets the hero start at the very top of the viewport.

## Raised panel

Elevation on dark comes from border and background, with shadow as support.

```css
.panel {
  background: var(--panel);
  border: 1px solid var(--border-lift);
  border-radius: 20px;
  box-shadow:
    0 40px 120px -40px rgba(0,0,0,0.9),
    inset 0 1px 0 rgba(255,255,255,0.04);
}
```

The `inset` line is a lit top edge. It is one line of CSS and it is most of the
difference between a card that sits on the page and one that floats above it.

Reserve the deep shadow for one element — usually the hero product frame. Applied
to every card it flattens back into noise.

## Bento grid

For parallel capabilities. Asymmetry is the point — equal tiles are just a grid.

```css
.bento {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 1rem;
}

.bento > *          { grid-column: span 2; }
.bento > .wide      { grid-column: span 4; }
.bento > .full      { grid-column: span 6; }

@media (max-width: 900px) {
  .bento { grid-template-columns: 1fr 1fr; }
  .bento > *, .bento > .wide, .bento > .full { grid-column: span 2; }
}
```

Give the most important tile the `wide` span and put real content in it — a
mini visual, a state, a number. A big tile with one sentence in it looks empty
and draws attention to the wrong thing.

## Reveal on scroll

One shared, rAF-throttled pass for every element. Cheaper than an observer per
element, and deterministic — which matters, because a reveal that silently fails
leaves the page blank.

```css
.reveal {
  opacity: 0;
  transform: translateY(18px);
  transition: opacity .7s cubic-bezier(.22,1,.36,1),
              transform .7s cubic-bezier(.22,1,.36,1);
}
.reveal[data-shown="true"] { opacity: 1; transform: none; }

@media (prefers-reduced-motion: reduce) {
  .reveal { opacity: 1; transform: none; }
  *, *::before, *::after {
    transition-duration: .001ms !important;
    animation-duration: .001ms !important;
  }
}
```

```js
const pending = new Set();
let scheduled = false, listening = false;

function check() {
  scheduled = false;
  const limit = window.innerHeight * 0.92;
  for (const entry of [...pending]) {
    if (entry.node.getBoundingClientRect().top < limit) {
      pending.delete(entry);
      setTimeout(() => entry.node.setAttribute("data-shown", "true"), entry.delay);
    }
  }
  if (!pending.size && listening) {
    window.removeEventListener("scroll", schedule);
    listening = false;
  }
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(check);
}

export function register(node, delay = 0) {
  pending.add({ node, delay });
  if (!listening) {
    window.addEventListener("scroll", schedule, { passive: true });
    listening = true;
  }
  schedule();               // elements already in view show immediately
}
```

The immediate `schedule()` on register is what prevents a short page — or a tall
viewport — from sitting blank waiting for a scroll that never comes.

**Debugging note.** Headless and hidden browser panes throttle
`requestAnimationFrame` and freeze CSS transitions mid-flight, so a reveal can
look broken when the markup is correct. Verify with the DOM, not the screenshot:
check whether `data-shown` is set before concluding the logic is wrong. To
screenshot layout without fighting animation, inject
`.reveal{opacity:1!important;transform:none!important;transition:none!important}`.

## Fluid token block

A complete starting palette and scale. Adjust the accent hues; keep the ramp.

```css
:root {
  --bg: #08090a;
  --bg-soft: #0b0c0e;
  --panel: #101214;

  --border: rgba(255,255,255,0.08);
  --border-lift: rgba(255,255,255,0.14);

  --text: #f2f4f6;
  --text-dim: #8f979e;
  --text-faint: #5f676d;

  --accent-a: #14c4f5;
  --accent-b: #6d4aef;
  --brand-gradient: linear-gradient(100deg, var(--accent-a), var(--accent-b));

  /* semantic only — never decorative */
  --amber: #f5a524;
  --red: #f4525f;

  --step-hero: clamp(2.6rem, 6.5vw, 5rem);
  --step-h2: clamp(1.9rem, 3.6vw, 2.9rem);
  --step-h3: clamp(1.4rem, 2.4vw, 2rem);

  --shell: min(1160px, 100% - 3rem);
  --radius: 14px;
  --radius-lg: 20px;
  --ease: cubic-bezier(.22, 1, .36, 1);
}
```
