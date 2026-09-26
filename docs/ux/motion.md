# Motion on the public site

The motion language of `frontends/web`: what moves, why, how, and the longer
list of what does not. Read it before you animate anything on the site, and
before you add a duration, an easing or a distance that is not a token.

The founders' brief, which outranks everything below: **less, slower to
notice, and purposeful.** The site is a set of drawings. When the reader stops
scrolling, the page is still.

## Principles

1. **Motion explains something or it does not exist.** Before adding a
   movement, finish the sentence "this shows the reader that …". If the only
   ending is "it looks good", leave it out.
2. **One moment per section at most.** Everything else in the section is still,
   apart from the shared arrival of blocks (below).
3. **Architectural, not elastic.** Things arrive and come to rest. Nothing
   bounces, springs, overshoots, pops, spins, shimmers or glows.
4. **Short distances.** 3 to 16px. A large element never travels across the
   screen by itself; scroll moves the page, the page does not move itself.
5. **The reader owns the scroll.** No snapping, no hijacked wheel, no pin below
   `lg`, no pin that holds a phone.
6. **At rest, exact.** When a motion ends, the element has no transform left on
   it, and a bitmap is shown at its own pixel size.

## Tokens

Defined twice, once per runtime, and kept in step by a check:

- CSS custom properties in `frontends/web/src/styles/global.css`
  (`@theme static`, so `ease-settle` and `ease-draft` are also Tailwind
  utilities);
- `frontends/web/src/lib/motion.ts` for scripts (GSAP and the Web Animations
  API); `src/scripts/motion-gsap.ts` registers the easings with GSAP under the
  same names, so a timeline says `ease: 'settle'`.

`scripts/lint-motion.mjs` (in `npm run check`) fails when the two disagree.

| Token | Value | For |
|---|---|---|
| `--duration-tick` | 120ms | State feedback: hover, press; a menu closing |
| `--duration-quick` | 200ms | Small things: a menu opening, a digit turning, a stamp, a page crossfade |
| `--duration-base` | 320ms | One element changing: a tick drawn, a colour change, the nav hiding |
| `--duration-slow` | 480ms | The longest single move on the site: a block arriving, an ink settling |
| `--ease-settle` | `cubic-bezier(0.16, 1, 0.3, 1)` | Almost everything: moves at once, comes to rest slowly |
| `--ease-draft` | `cubic-bezier(0.65, 0, 0.35, 1)` | A line being drawn, a camera move, a crossfade |
| `--stagger-row` | 60ms | Between items of one short list |
| `--stagger-max` | 240ms | Ceiling on a whole stagger (`staggerFor()` in motion.ts) |
| `--travel-hair` | 3px | Misregistration of an ink |
| `--travel-sm` / `--travel-md` | 8px / 16px | Everything else that moves |

Two easings and four durations is the whole vocabulary. A new value is a change
to this document, not a local tweak.

Scrubbed motion (tied to scroll position) uses no easing and no duration: it is
`ease: 'none'` against the scroll, and it exists only on the desktop story and
the hero's fade.

## What moves, section by section

Each entry is the one thing the section does, and what it explains.

| Where | Motion | What it explains | Tokens |
|---|---|---|---|
| Any page change | 200ms crossfade; the navigation bar stays still | One document turning to the next; the bar is the same object on every page | quick, draft |
| Any block marked `data-reveal` | Opacity 0 → 1 and 16px up, once, as it enters; a row arrives as a row | The page is being laid out as you arrive, and nothing below the fold flashes | slow, settle, row |
| Hero (lg) | Closing line, buttons and stage note fade over the first 25% of a screen; the headline over 20–50%. Opacity only | Nothing prints through the logo under the transparent bar | scrubbed |
| Story (lg) | Pinned, scrubbed: fragments drift in, the problem gives way to the answer, the net pulls them in and wires them, then holds. 240vh (ring) or 200vh (grid) | Scattered knowledge becoming one structure: the section's argument | scrubbed |
| Story (phone) | The hub grid's nodes and hub fade in, then the wires draw, once | The nodes are wired to one hub | slow, settle, draft |
| Nutzung, desktop chain | Plays once when in view; pause/resume while it runs, replay after | How an answer is derived: question, sources, decision, steps | slow, draft |
| Daten & Transparenz (Prüfblatt) | The four ticks draw in order, 60ms apart, once | Each claim is checked, one by one | base, draft, row |
| Wertrechner | When a slider moves, only the digits that changed turn on their wheels | Which part of the figure your office moved | quick, settle |
| A riso plate (TapedPrint) | Ink pass: each ink 2–3px out of register settles into it, ~600ms in all, once | The print is a print: inks laid one after another | slow, settle, hair, row |
| Phone menu | Opens 200ms, closes 120ms, 8px; the page behind does not scroll | Where the sheet comes from | quick, tick, settle |
| Navigation rail | Condenses at 60% of the hero; over a dark panel it turns dark (colour, 320ms) | Legibility, not decoration | base, draft |
| Craft kit | Stamp settles from 1.04; pencil line draws, once | A mark made on the sheet | quick, base |

### The ink pass

`src/components/motion/InkPass.astro` (+ `ink-pass.ts`). TapedPrint wraps every
plate in it; `still` opts a plate out. The layers exist only while the pass
plays: when it ends they are removed and the untouched `<img>` is shown, so at
rest the page holds the file on disk at its native size.

Two sources for the inks:

- **Separations**, when the riso kit has exported them (below): the real inks,
  multiplied over the paper, so the pass is exactly the print.
- **Bands**, until then: the print split by two SVG luminance filters into a
  pale ground ink (Mist) and a middle ink (Moss), then the whole print as the
  key. Every ink on these plates is a green, so there is no hue to separate
  them by; the approximation keeps the true order (light first, key last).

**The separation export.** Per plate job that the site serves (the 720 and
1440 squares, and the 800/1600 banner if a banner is ever passed through
TapedPrint), beside `<file>.webp` in `public/art/`:

- `<file>-paper.webp`: `bakePaper()` alone, opaque, at the job's size.
- `<file>-<ink>.webp` for each ink in the plate's `inks` list: the `tin` canvas
  of `bakeJob()` (ink colour, dot alpha, transparent elsewhere), drawn on a
  transparent canvas of the job's size **at its registration offset**
  (`Math.round(REG[ink] × K × 0.7)`), exactly as it is multiplied into the
  composite. WebP with alpha at quality 95, like the composites.
- The same engine as the composite (Firefox through the kit's `still.mjs`):
  the stack must reproduce the composite to within compression error. Measured
  on a Chromium prototype, paper × inks matched its own composite to a mean
  0.9/255, but Chromium and Firefox renders differ by a mean 2.4/255, which is
  a visible swap at the end of the pass.

TapedPrint finds the files at build time and turns the real pass on for that
plate; nothing else changes. They add about 170 KB (720) per plate, loaded only
when the pass plays.

## Page transitions: native, not ClientRouter

Both were evaluated.

- **Astro's `ClientRouter`** swaps the DOM in place. Every module script then
  runs once per session instead of once per page, so each would need
  re-initialising on `astro:page-load` and tearing down on `astro:before-swap`:
  the GSAP ScrollTriggers and `matchMedia` branches in `landing.ts`, the pinned
  story and its runway height, the aura canvas loop, the chain, the calculator,
  the sheet index, the navigation and menu listeners, sign-in, the craft kit's
  observers, and the blog's reveal. Missing one leaves a dead trigger or a
  duplicated listener, and the scripts belong to several people.
- **Cross-document view transitions** (`@view-transition { navigation: auto }`)
  keep ordinary page loads: every script runs exactly once per page, bfcache
  still works, and a browser without support (Firefox, as of writing) simply
  navigates. It is CSS only.

The site uses the second. A sheet slide, a back-navigation "take away" and a
card-to-title morph were built on it and removed: a page change is worth a
crossfade, not a performance.

## Reduced motion

`prefers-reduced-motion: reduce` gets a complete, designed page, not a broken
one:

- no page transitions (the `@view-transition` rule sits inside a
  `no-preference` query);
- no pin and no runway: the story is its resolved hub on one screen;
- the chain board is replaced by the finished column list;
- reveals, ticks, stamp, pencil and the ink pass are armed only under
  `no-preference`, so their elements are in their final state from the start;
- the calculator sets its figure instead of turning it;
- the global rule in `global.css` stops any remaining CSS animation.

The same final states are what a visitor without JavaScript sees: every motion
hides an element only through a class its script adds.

## Performance budget

- Animate `transform` and `opacity` only. `clip-path` and `stroke-dashoffset`
  on small elements (a tick, a line) are allowed. Never `filter`, `width`,
  `height`, `top`/`left`, or anything that lays out.
- No layout reads inside an animation frame. Measure once (on build, resize or
  ScrollTrigger refresh), then animate.
- 60 fps on a mid phone: under 4× CPU throttling at 390×844 a full scroll of
  the landing page produces no long task and no layout shift.
- A `backdrop-filter` over something that animates is re-computed on every
  frame. The hero keeps one (it had four; see the comment in `Hero.astro` for
  the numbers).
- Pages that do not need GSAP do not load it: the ink pass, the counter, the
  menu and the craft kit use the Web Animations API or CSS.

## When not to animate

- Text. No headline typed in, split into words, or revealed by scroll. No
  parallax on text.
- Numbers counting up. A figure is shown, or its changed digits turn.
- Anything decorative that keeps moving after the reader stops: no pulsing
  hints, no idle loops, no shimmer. (The hero's aura is the one deliberate
  exception, and it is the founders'.)
- Cursor followers, magnetic buttons, tilt on hover, scale on hover.
- Scroll snapping, anywhere.
- Loops. A sequence plays once; if it is longer than five seconds, it can be
  paused (WCAG 2.2.2).
- Anything already on screen at load: it is not hidden and replayed.
- A second moment in a section that already has one.

Built and cut, so nobody builds them again without reading why: a plotter
drawing of every section tag, the Datengrundlage cards dealt out of a stack,
a parallax hero photograph, the story panel rising over the hero, the counter
spinning a full turn on first sight, the ink pass's top-to-bottom drum wipe,
the sheet-slide page change, the card-to-title morph.
