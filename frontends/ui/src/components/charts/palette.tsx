/**
 * GRID's categorical chart palette. Slot ORDER is the CVD-safety mechanism —
 * never reorder or cycle; entities beyond 8 slots fold into "Other".
 *
 * The order below is VALIDATED, and the previous one was not, despite this
 * comment having claimed it was. Orange and magenta sat in adjacent slots and
 * the pair failed the normal-vision floor at ΔE 12.9 (threshold 15) — readers
 * with full colour vision could not reliably tell two neighbouring series
 * apart. Re-ordering fixed it with zero hex changes; the worst adjacent pair is
 * now ΔE 19.6 light / 19.3 dark.
 *
 * Re-validate with the dataviz validator after ANY change, against this app's
 * real surfaces — do not eyeball it, that is how the bad order shipped:
 *
 *   node <dataviz-skill>/scripts/validate_palette.js \
 *     "#2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4,#008300,#4a3aa7,#e34948" --mode light
 *   node <dataviz-skill>/scripts/validate_palette.js \
 *     "#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767" --mode dark
 *
 * Light mode still WARNs on contrast for aqua/yellow/magenta (all under 3:1 on
 * a near-white surface). That warning is not dismissable: every consumer must
 * provide relief — visible labels or an always-open table — so a value is never
 * reachable through colour alone.
 *
 * The values below are MIRRORED from `app/globals.css` (`.grid-spend-viz`),
 * which is authoritative — see the TWIN WARNING above the arrays.
 *
 * Consumers style marks with `var(--grid-series-N)` / `--grid-series-other`
 * inside an element that renders <SeriesPaletteStyle/> and carries the
 * `grid-usage-viz` class — dark steps switch under `.dark` automatically.
 */

import type { FC } from 'react'

/* ── TWIN WARNING ─────────────────────────────────────────────────────────────
 *
 * These eight+one values also exist in `src/app/globals.css` as
 * `--spend-series-1…8` / `--spend-other` under `.grid-spend-viz` (light) and
 * `.dark .grid-spend-viz` — one palette written down twice, which is one copy
 * too many.
 *
 * **`app/globals.css` is AUTHORITATIVE.** It carries the validator transcript
 * (the ΔE and contrast runs against this app's real `--card` surfaces, and the
 * non-dismissable light-mode contrast WARN) that justifies each step, and the
 * status pair `--spend-meter` / `--spend-meter-over` that must never collide
 * with a series slot. Change a value THERE first, re-run the validator, then
 * mirror it here. Never the other way round.
 *
 * Why this file cannot simply read the twin, which was the preferred fix:
 * `--spend-series-*` are declared on the `.grid-spend-viz` SCOPE, not on
 * `:root`, so `.grid-usage-viz { --grid-series-1: var(--spend-series-1) }`
 * resolves to nothing unless a `.grid-spend-viz` ancestor happens to be in the
 * tree — and the usage charts (citation defects, answer feedback) deliberately
 * do not opt into the spend scope, because those slots mean "money by model"
 * there. Reading the file at build time is out too: `SeriesPaletteStyle` ships
 * inside client components, so there is no `fs` at the point of use.
 *
 * FOLLOW-UP for the `app/globals.css` owner — either of these deletes the twin
 * for good, and both are one-sided changes this side cannot make:
 *   1. promote the eight series steps to `:root` (they are already global in
 *      practice), leaving `.grid-spend-viz` to alias them; this file then emits
 *      `var(--spend-series-N)` and holds no hex at all; or
 *   2. drop the CSS copy and let this module be the single source, in which
 *      case the validator transcript moves here with it.
 * Until one lands, `globals.css` needs the reciprocal pointer back to this
 * file so a reader who edits one is told about the other.
 */

export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
export const OTHER_LIGHT = '#767672'
export const OTHER_DARK = '#8f8e89'

export const SERIES_SLOT_COUNT = SERIES_LIGHT.length

export const SeriesPaletteStyle: FC = () => (
  <style>{`
    .grid-usage-viz {
      ${SERIES_LIGHT.map((hex, i) => `--grid-series-${i + 1}: ${hex};`).join('\n      ')}
      --grid-series-other: ${OTHER_LIGHT};
    }
    .dark .grid-usage-viz {
      ${SERIES_DARK.map((hex, i) => `--grid-series-${i + 1}: ${hex};`).join('\n      ')}
      --grid-series-other: ${OTHER_DARK};
    }
  `}</style>
)
