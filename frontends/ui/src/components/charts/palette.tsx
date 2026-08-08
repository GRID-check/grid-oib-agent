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
 * Consumers style marks with `var(--grid-series-N)` / `--grid-series-other`
 * inside an element that renders <SeriesPaletteStyle/> and carries the
 * `grid-usage-viz` class — dark steps switch under `.dark` automatically.
 */

import type { FC } from 'react'

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
